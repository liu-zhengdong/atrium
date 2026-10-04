package hosts

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Host 是 hosts 表的一行（令牌与接入码只有哈希，不出这个包）。
type Host struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Kind         string   `json:"kind"`
	Repos        []string `json:"repos"`
	MaxRunning   int      `json:"max_running,omitempty"`
	Joined       bool     `json:"joined"`
	JoinExpires  int64    `json:"join_expires_at,omitempty"`
	Info         *Info    `json:"info,omitempty"`
	Load         *Load    `json:"load,omitempty"`
	SSH          string   `json:"ssh,omitempty"`
	Key          string   `json:"key,omitempty"` // 隧道私钥路径
	TunnelLocal  int      `json:"tunnel_local,omitempty"`
	TunnelRemote int      `json:"tunnel_remote,omitempty"`
	LastSeen     int64    `json:"last_seen_at,omitempty"`
	CreatedAt    int64    `json:"created_at"`
}

func digest(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

func secret() string {
	b := make([]byte, 32)
	rand.Read(b)
	return hex.EncodeToString(b)
}

const hostCols = `id, name, kind, repos, COALESCE(max_running, 0), token_hash != '', COALESCE(join_expires_at, 0), info, load,
	ssh_target, ssh_key, COALESCE(tunnel_local, 0), COALESCE(tunnel_remote, 0), COALESCE(last_seen_at, 0), created_at`

func scanHost(sc interface{ Scan(...any) error }) (Host, error) {
	var h Host
	var repos, info, load string
	if err := sc.Scan(&h.ID, &h.Name, &h.Kind, &repos, &h.MaxRunning, &h.Joined, &h.JoinExpires, &info, &load,
		&h.SSH, &h.Key, &h.TunnelLocal, &h.TunnelRemote, &h.LastSeen, &h.CreatedAt); err != nil {
		return h, err
	}
	if err := json.Unmarshal([]byte(repos), &h.Repos); err != nil {
		return h, err
	}
	if info != "" {
		h.Info = &Info{}
		if err := json.Unmarshal([]byte(info), h.Info); err != nil {
			return h, err
		}
	}
	if load != "" {
		h.Load = &Load{}
		if err := json.Unmarshal([]byte(load), h.Load); err != nil {
			return h, err
		}
	}
	return h, nil
}

// Get 读一台机器。
func Get(ctx context.Context, q store.Querier, id string) (Host, error) {
	h, err := scanHost(q.QueryRowContext(ctx, `SELECT `+hostCols+` FROM hosts WHERE id = ?`, id))
	if store.IsNotFound(err) {
		return h, api.NotFound("没有机器 %s", id).WithNext("atrium host ls")
	}
	return h, err
}

// List 列出全部机器（机器数很小，仍有上限）。
func List(ctx context.Context, q store.Querier) ([]Host, error) {
	rows, err := hostRows(ctx, q)
	if err != nil {
		return nil, err
	}
	out := make([]Host, 0, len(rows))
	for _, row := range rows {
		if row.err != nil {
			return nil, row.err
		}
		out = append(out, row.host)
	}
	return out, nil
}

type hostRow struct {
	host Host
	err  error
}

// hostRows 保留单条解析错误，让后台遍历能在该机器的边界处理。
func hostRows(ctx context.Context, q store.Querier) ([]hostRow, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+hostCols+` FROM hosts ORDER BY CAST(substr(id, 2) AS INTEGER) LIMIT 500`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []hostRow
	for rows.Next() {
		h, err := scanHost(rows)
		out = append(out, hostRow{h, err})
	}
	return out, rows.Err()
}

// EnsureLocal 登记本机（第一次启动时发到 h1），之后每次启动刷新机器信息。
// 刷新与自检（setCLIs）会并发，clis 只归自检写，刷新走 touch 保留库里的。
func EnsureLocal(ctx context.Context, db *store.DB, info Info) error {
	raw, _ := json.Marshal(info)
	return db.Tx(ctx, func(tx *sql.Tx) error {
		var id string
		err := tx.QueryRowContext(ctx, `SELECT id FROM hosts WHERE kind = 'local'`).Scan(&id)
		if err == nil {
			return touch(ctx, tx, id, &info, nil)
		}
		if !store.IsNotFound(err) {
			return err
		}
		if id, err = store.NextID(ctx, tx, "h"); err != nil {
			return err
		}
		if id != Local {
			return api.Conflict("本机应为 h1，短号却发到了 %s：hosts 表被动过", id)
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO hosts (id, name, kind, repos, info, last_seen_at, created_at)
			VALUES (?, '本机', 'local', '["*"]', ?, ?, ?)`, id, string(raw), store.Now(), store.Now())
		return err
	})
}

// Add 登记一台远程机器，返回一次性接入码 hN-<64 位十六进制>（30 分钟有效）。
func Add(ctx context.Context, db *store.DB, in AddInput, servicePort int) (Host, string, error) {
	local, remote, err := in.Validate(servicePort)
	if err != nil {
		return Host{}, "", err
	}
	repos, _ := json.Marshal(in.Repos)
	var code string
	var h Host
	err = db.Tx(ctx, func(tx *sql.Tx) error {
		id, err := store.NextID(ctx, tx, "h")
		if err != nil {
			return err
		}
		code = id + "-" + secret()
		now := store.Now()
		if _, err := tx.ExecContext(ctx, `INSERT INTO hosts (id, name, kind, repos, max_running, join_hash, join_expires_at,
			ssh_target, ssh_key, tunnel_local, tunnel_remote, created_at) VALUES (?, ?, 'remote', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, in.Name, string(repos), nullInt(in.Max), digest(code), now+joinTTL, in.SSH, in.Key, nullInt(local), nullInt(remote), now); err != nil {
			return err
		}
		h, err = Get(ctx, tx, id)
		return err
	})
	return h, code, err
}

func nullInt(n int) any {
	if n == 0 {
		return nil
	}
	return n
}

// EditInput 是 host edit 的参数：nil 表示不改。SSH 给空串是去掉隧道（连同端口与私钥）。
type EditInput struct {
	Repos  *[]string `json:"repos,omitempty"`
	Max    *int      `json:"max,omitempty"`
	SSH    *string   `json:"ssh,omitempty"`
	Tunnel *string   `json:"tunnel,omitempty"`
	Key    *string   `json:"key,omitempty"`
	Join   bool      `json:"join,omitempty"` // 发新的一次性接入码（导入的旧机器没有令牌，要重新接入）
}

// EditPlan 纯判定：把改动叠到现有登记上，得到按 host add 同一套规则校验的完整参数。
// 隧道本机端口没登记过（导入的旧机器）时按服务端口算。
func EditPlan(h Host, e EditInput, servicePort int) AddInput {
	in := AddInput{Name: h.Name, Repos: h.Repos, Max: h.MaxRunning, SSH: h.SSH, Key: h.Key}
	if h.SSH != "" && h.TunnelRemote != 0 {
		local := h.TunnelLocal
		if local == 0 {
			local = servicePort
		}
		in.Tunnel = fmt.Sprintf("%d:%d", local, h.TunnelRemote)
	}
	if e.Repos != nil {
		in.Repos = *e.Repos
	}
	if e.Max != nil {
		in.Max = *e.Max
	}
	if e.SSH != nil {
		in.SSH = *e.SSH
		if in.SSH == "" {
			in.Tunnel, in.Key = "", ""
		}
	}
	if e.Tunnel != nil {
		in.Tunnel = *e.Tunnel
	}
	if e.Key != nil {
		in.Key = *e.Key
	}
	return in
}

// Edit 改一台远程机器的登记（仓库、并发上限、隧道与私钥）；隧道由后台循环按新登记重连。
// Join 时另发一次性接入码（30 分钟有效；旧令牌在新代理接入前照常有效）。
func Edit(ctx context.Context, db *store.DB, id string, e EditInput, servicePort int) (Host, string, error) {
	var h Host
	var code string
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		cur, err := Get(ctx, tx, id)
		if err != nil {
			return err
		}
		if cur.Kind == "local" {
			return api.Conflict("本机（h1）不用登记这些；不想在本机跑可以暂停它").WithNext("atrium pause --host h1")
		}
		in := EditPlan(cur, e, servicePort)
		local, remote, err := in.Validate(servicePort)
		if err != nil {
			return err
		}
		repos, _ := json.Marshal(in.Repos)
		if _, err := tx.ExecContext(ctx, `UPDATE hosts SET repos = ?, max_running = ?, ssh_target = ?, ssh_key = ?,
			tunnel_local = ?, tunnel_remote = ? WHERE id = ?`,
			string(repos), nullInt(in.Max), in.SSH, in.Key, nullInt(local), nullInt(remote), id); err != nil {
			return err
		}
		if e.Join {
			code = id + "-" + secret()
			if _, err := tx.ExecContext(ctx, `UPDATE hosts SET join_hash = ?, join_expires_at = ? WHERE id = ?`,
				digest(code), store.Now()+joinTTL, id); err != nil {
				return err
			}
		}
		h, err = Get(ctx, tx, id)
		return err
	})
	return h, code, err
}

// Remove 移除远程机器：令牌作废，短号不复用；上面还有在跑的任务时拒绝。
func Remove(ctx context.Context, db *store.DB, id string) error {
	return db.Tx(ctx, func(tx *sql.Tx) error {
		h, err := Get(ctx, tx, id)
		if err != nil {
			return err
		}
		if h.Kind == "local" {
			return api.Conflict("本机（h1）不能移除；不想在本机跑可以暂停它").WithNext("atrium pause --host h1")
		}
		var task string
		err = tx.QueryRowContext(ctx, `SELECT id FROM tasks WHERE status = 'running' AND host = ? LIMIT 1`, id).Scan(&task)
		if err == nil {
			return api.Conflict("%s 上还有在跑的任务 %s；先停下或等它结束", id, task).WithNext("atrium task stop " + task)
		}
		if !store.IsNotFound(err) {
			return err
		}
		if err := quota.DropHost(ctx, tx, id); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM hosts WHERE id = ?`, id)
		return err
	})
}

var (
	joinPattern  = regexp.MustCompile(`^(h[1-9][0-9]{0,8})-[a-f0-9]{64}$`)
	tokenPattern = regexp.MustCompile(`^(h[1-9][0-9]{0,8})\.[a-f0-9]{64}$`)
)

// Join 用接入码换这台机器专用的令牌（只回这一次）；码用过即作废。
func Join(ctx context.Context, db *store.DB, code string, info Info) (string, string, error) {
	refused := &api.Error{Status: 401, Code: "unauthorized",
		Message: "接入码无效、已用过或已过期；在服务那台机器上运行 atrium host edit <hN> --join 拿新的接入码"}
	m := joinPattern.FindStringSubmatch(code)
	if m == nil {
		return "", "", refused
	}
	id := m[1]
	token := id + "." + secret()
	raw, _ := json.Marshal(info)
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		var hash string
		var expires int64
		err := tx.QueryRowContext(ctx, `SELECT join_hash, COALESCE(join_expires_at, 0) FROM hosts WHERE id = ? AND kind = 'remote'`, id).
			Scan(&hash, &expires)
		if store.IsNotFound(err) {
			return refused
		}
		if err != nil {
			return err
		}
		if hash == "" || expires < store.Now() || subtle.ConstantTimeCompare([]byte(digest(code)), []byte(hash)) != 1 {
			return refused
		}
		_, err = tx.ExecContext(ctx, `UPDATE hosts SET token_hash = ?, join_hash = '', join_expires_at = NULL, info = ?, last_seen_at = ?
			WHERE id = ?`, digest(token), string(raw), store.Now(), id)
		return err
	})
	return id, token, err
}

// Verify 认机器令牌 hN.<64 位十六进制>；认出返回 hN。
func Verify(ctx context.Context, q store.Querier, token string) (string, bool) {
	m := tokenPattern.FindStringSubmatch(token)
	if m == nil {
		return "", false
	}
	var hash string
	if err := q.QueryRowContext(ctx, `SELECT token_hash FROM hosts WHERE id = ? AND kind = 'remote'`, m[1]).Scan(&hash); err != nil || hash == "" {
		return "", false
	}
	return m[1], subtle.ConstantTimeCompare([]byte(digest(token)), []byte(hash)) == 1
}

// touch 记心跳；info、load 给了就一并更新。info 里的 clis 只归自检（setCLIs）写，这里保留库里的：
// hello 与自检上报会同时到，各改各的字段、同一条 UPDATE 里合并，谁也不盖掉谁。
func touch(ctx context.Context, q store.Querier, id string, info *Info, load *Load) error {
	var infoRaw, loadRaw any
	if info != nil {
		b, _ := json.Marshal(info)
		infoRaw = string(b)
	}
	if load != nil {
		b, _ := json.Marshal(load)
		loadRaw = string(b)
	}
	_, err := q.ExecContext(ctx, `UPDATE hosts SET last_seen_at = ?, info = COALESCE(json_set(?, '$.clis', info -> '$.clis'), info), load = COALESCE(?, load) WHERE id = ?`,
		store.Now(), infoRaw, loadRaw, id)
	return err
}

// setCLIs 记一轮自检的可用工具（只改 info 里的 clis）。
func setCLIs(ctx context.Context, q store.Querier, id string, clis map[string]CLI) error {
	b, _ := json.Marshal(clis)
	_, err := q.ExecContext(ctx, `UPDATE hosts SET last_seen_at = ?, info = json_set(COALESCE(info, '{}'), '$.clis', json(?)) WHERE id = ?`,
		store.Now(), string(b), id)
	return err
}

// running 数各台机器上在跑的任务。
func running(ctx context.Context, q store.Querier) (map[string]int, error) {
	rows, err := q.QueryContext(ctx, `SELECT host, COUNT(*) FROM tasks WHERE status = 'running' AND host != '' GROUP BY host LIMIT 500`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var h string
		var n int
		if err := rows.Scan(&h, &n); err != nil {
			return nil, err
		}
		out[h] = n
	}
	return out, rows.Err()
}

// ---- 远程运行 ----

// Exit 是一次远程运行的退出：Code 为 nil 表示退出码不可得（代理重启时进程已不在，或代理丢了这一轮）。
type Exit struct {
	Code *int `json:"code"`
	Lost bool `json:"lost"`
}

type runRow struct {
	RunRef
	Host    string
	PID     int
	LogFile string
	Offset  int64
	Exited  bool
	Exit    Exit
}

func getRun(ctx context.Context, q store.Querier, task string) (runRow, error) {
	var r runRow
	var code sql.NullInt64
	var exited sql.NullInt64
	err := q.QueryRowContext(ctx, `SELECT task, run, host, pid, log_file, log_offset, exit_code, exit_lost, exited_at
		FROM host_runs WHERE task = ?`, task).Scan(&r.Task, &r.Run, &r.Host, &r.PID, &r.LogFile, &r.Offset, &code, &r.Exit.Lost, &exited)
	if code.Valid {
		c := int(code.Int64)
		r.Exit.Code = &c
	}
	r.Exited = exited.Valid
	return r, err
}

// openRuns 只对账已回执的运行；pid=0 的轮次由 Launch 收尾。
func openRuns(ctx context.Context, q store.Querier, host string) ([]RunRef, error) {
	rows, err := q.QueryContext(ctx, `SELECT task, run FROM host_runs WHERE host = ? AND pid > 0 AND exited_at IS NULL ORDER BY task LIMIT 1000`, host)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RunRef
	for rows.Next() {
		var r RunRef
		if err := rows.Scan(&r.Task, &r.Run); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func finishRun(ctx context.Context, q store.Querier, r RunRef, e Exit) error {
	_, err := q.ExecContext(ctx, `UPDATE host_runs SET exit_code = ?, exit_lost = ?, exited_at = ? WHERE task = ? AND run = ? AND exited_at IS NULL`,
		e.Code, e.Lost, store.Now(), r.Task, r.Run)
	return err
}

func validLogFile(p string) bool { return p != "" && !strings.ContainsRune(p, 0) }

// RecoverLaunches 在分派任务启动前收尾旧进程未回执的轮次；其内存指令队列已不存在。
func RecoverLaunches(ctx context.Context, q store.Querier) error {
	_, err := q.ExecContext(ctx, `UPDATE host_runs SET exit_lost = 1, exited_at = ? WHERE pid = 0 AND exited_at IS NULL`, store.Now())
	return err
}
