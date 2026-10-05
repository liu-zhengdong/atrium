package hosts

import (
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 纯判定：连接状态、能不能接、挑哪台、日志续传、重连对账、参数校验。不碰数据库、网络与进程。

// Local 是本机的短号：服务启动时第一个登记，固定 h1。
const Local = "h1"

const (
	joinTTL  = 30 * 60_000 // 接入码有效期
	onlineMs = 60_000      // 多久没来算离线（长轮询每轮最多 25 秒）
)

// CLI 是一台机器上某个编码 CLI 的情况。LoggedIn 为 nil 表示看不出。
type CLI struct {
	Version   string `json:"version,omitempty"`
	Installed bool   `json:"installed"`
	LoggedIn  *bool  `json:"logged_in"`
}

// Info 是机器的自我介绍（代理接入与每次重连时报，本机服务启动时报）。
type Info struct {
	Hostname   string         `json:"hostname"`
	OS         string         `json:"os"`
	Arch       string         `json:"arch"`
	CPUs       int            `json:"cpus"`
	Version    string         `json:"version"`
	Data       string         `json:"data"`        // 代理数据目录
	CLIs       map[string]CLI `json:"clis"`        // nil 尚未自检；空 map 自检完成但无可用工具
	MaxWorkers int            `json:"max_workers"` // 按核数算的执行者上限
}

// Load 是代理每轮长轮询带上的负载。
type Load struct {
	Load    float64 `json:"load"`
	Running int     `json:"running"`
	Busy    string  `json:"busy,omitempty"` // 代理自己判太忙的原因
}

// Conn 是连接状态。
type Conn string

const (
	ConnLocal   Conn = "local"
	ConnOnline  Conn = "online"
	ConnOffline Conn = "offline"
	ConnPending Conn = "pending" // 等接入，接入码有效
	ConnExpired Conn = "expired" // 接入码过期
)

// Connection 判连接状态。
func Connection(kind string, joined bool, joinExpires, lastSeen int64, polling bool, now int64) Conn {
	switch {
	case kind == "local":
		return ConnLocal
	case !joined && joinExpires > now:
		return ConnPending
	case !joined:
		return ConnExpired
	case polling || (lastSeen > 0 && now-lastSeen <= onlineMs):
		return ConnOnline
	}
	return ConnOffline
}

// ConnText 是连接状态的一句人话。
func ConnText(c Conn, paused bool, lastSeen, joinExpires, now int64) string {
	mins := func(ms int64) int64 { return max(1, (ms+30_000)/60_000) }
	var s string
	switch c {
	case ConnLocal:
		s = "本机"
	case ConnOnline:
		s = "在线"
	case ConnOffline:
		s = "离线"
		if lastSeen > 0 {
			s = fmt.Sprintf("离线（%d 分钟前最后心跳）", mins(now-lastSeen))
		}
	case ConnPending:
		s = fmt.Sprintf("待接入（接入码 %d 分钟内有效）", mins(joinExpires-now))
	default:
		s = "接入码已过期"
	}
	if paused {
		s += " · 已暂停接活"
	}
	return s
}

// Candidate 是挑机器时的一台。
type Candidate struct {
	ID          string
	Kind        string
	Conn        Conn
	Paused      bool
	CLIs        map[string]CLI // 这台实测可用的工具（本机与远程相同）
	Marks       []workers.Mark // 此刻有效的不可用标记（各台的都在，workers.Blocked 按机器筛）
	Unavailable string         // 本轮共同可用性判断（workers.CheckResolved）挡住的原因，排队等它解除；不持久化
	Repos       []string       // 自动分派任务能接的仓库（owner/name，* 为全部）；指定 --host 不看
	Running     int
	Max         int    // 同时最多跑几个；0 不限
	Busy        string // 代理报的太忙原因
}

// Need 是一件活对机器的要求。
type Need struct {
	Task   string `json:"task,omitempty"` // 同一任务二次拉起复用已有容量，不把它自己再计一次
	Tool   string `json:"tool"`
	Model  string `json:"model,omitempty"`
	Repo   string `json:"repo"` // owner/name；没有仓库为空
	Urgent bool   `json:"urgent"`
	// LocalOnly 非空时只能在本机跑（远程拿不到这个仓库），写原因。
	LocalOnly string `json:"local_only,omitempty"`
}

// Choice 是挑机器的结论：run 在 Host 上拉起；queue 排队（Host 非空表示钉在指定的那台）；refuse 拒绝。
// Held 只在 queue 上有意义：为真表示排队的根因是「不可用标记/离线/自检未就绪」这类等恢复的，
// 不是正忙满载的正常排队——挑人的一侧据此决定要不要上报知会（dispatch 的空池兜底）。
type Choice struct {
	Kind   string `json:"kind"`
	Host   string `json:"host,omitempty"`
	Reason string `json:"reason,omitempty"`
	Held   bool   `json:"held,omitempty"`
}

// RepoAllowed：没有仓库的活都能接；有仓库时要登记过（* 为全部）。
func RepoAllowed(repos []string, repo string) bool {
	if repo == "" {
		return true
	}
	for _, r := range repos {
		if r == "*" || strings.EqualFold(r, repo) {
			return true
		}
	}
	return false
}

// fit 判这台能不能接：never 接不了，later 这会儿不行（满、太忙，或远程暂时不在）。pinned 是用户 --host 指定的（不看仓库）。
// held 只在 later 为真时有意义：标记不可用、离线、自检未就绪这类「等恢复」的排队是真，满载正忙是假。
func fit(c Candidate, n Need, pinned bool) (ok bool, later bool, held bool, reason string) {
	if c.Kind == "remote" {
		switch c.Conn {
		case ConnPending, ConnExpired:
			return false, false, false, c.ID + " 还没接入"
		case ConnOffline:
			// 心跳断了或服务重启后还没重连。机器还是这台，等它回来再派，不转受阻。
			return false, true, true, c.ID + " 离线"
		}
	}
	if c.Kind == "remote" && n.LocalOnly != "" {
		return false, false, false, c.ID + " 是远程机器：" + n.LocalOnly
	}
	if c.Paused {
		return false, false, false, c.ID + " 已暂停接活"
	}
	if n.Tool != "" {
		if c.CLIs == nil {
			return false, true, true, c.ID + " 尚未完成工具自检，自检就绪后再派"
		}
		cli := c.CLIs[n.Tool]
		if !cli.Installed {
			return false, false, false, fmt.Sprintf("%s 上没装 %s", c.ID, n.Tool)
		}
		if cli.LoggedIn != nil && !*cli.LoggedIn {
			return false, false, false, fmt.Sprintf("%s 上的 %s 没登录", c.ID, n.Tool)
		}
	}
	why := c.Unavailable
	if m, ok := workers.Blocked(c.Marks, n.Tool, n.Model, c.ID); ok {
		why = m.Text()
	}
	if why != "" {
		// 标记会到期或被解除（自检跑通、人 --clear），等它而不是拒绝：拒绝会让任务转受阻，恢复后没人再派。
		return false, true, true, fmt.Sprintf("%s 上的 %s 不可用：%s", c.ID, workers.Spec{Tool: n.Tool, Model: n.Model}, why)
	}
	if c.Kind == "remote" && !pinned && !RepoAllowed(c.Repos, n.Repo) {
		if n.Repo == "" {
			return false, false, false, c.ID + " 不接这件活"
		}
		return false, false, false, fmt.Sprintf("%s 没登记能接仓库 %s（atrium host add 时用 --repo 登记）", c.ID, n.Repo)
	}
	if n.Urgent {
		return true, false, false, ""
	}
	if c.Busy != "" {
		return false, true, false, c.Busy
	}
	if c.Max > 0 && c.Running >= c.Max {
		return false, true, false, fmt.Sprintf("%s 同时最多跑 %d 个执行者，有执行者结束后再拉起", c.ID, c.Max)
	}
	return true, false, false, ""
}

func utilization(c Candidate) float64 {
	if c.Max <= 0 {
		return float64(c.Running) / 1000
	}
	return float64(c.Running) / float64(c.Max)
}

func crowded(c Candidate) bool { return c.Busy != "" || (c.Max > 0 && c.Running >= c.Max) }

// Choose 挑机器：指定了只看那台（接不了拒绝，满了或暂时不在就排队）；否则在能接的里挑最空的，一样空本机优先；
// 紧急的先挑不满不忙的；暂停的一律不选；远程只自动接登记过的仓库；都满时排队，本机的原因优先。
func Choose(cands []Candidate, n Need, pinned string) Choice {
	if pinned != "" {
		for _, c := range cands {
			if c.ID != pinned {
				continue
			}
			ok, later, held, reason := fit(c, n, true)
			switch {
			case ok:
				return Choice{Kind: "run", Host: c.ID}
			case later:
				return Choice{Kind: "queue", Host: c.ID, Reason: reason, Held: held}
			}
			return Choice{Kind: "refuse", Reason: reason}
		}
		return Choice{Kind: "refuse", Reason: "没有机器 " + pinned}
	}
	var ready []Candidate
	var laterReason, localLater, localNever string
	var laterHeld, localHeld bool
	for _, c := range cands {
		ok, later, held, reason := fit(c, n, false)
		switch {
		case ok:
			ready = append(ready, c)
		case later && c.Kind == "local":
			localLater, localHeld = reason, held
		case later && laterReason == "":
			laterReason, laterHeld = reason, held
		case !later && c.Kind == "local":
			localNever = reason
		}
	}
	if len(ready) > 0 {
		local := func(c Candidate) int {
			if c.Kind == "local" {
				return 0
			}
			return 1
		}
		sort.SliceStable(ready, func(i, j int) bool {
			a, b := ready[i], ready[j]
			if n.Urgent && crowded(a) != crowded(b) {
				return !crowded(a)
			}
			if n.Urgent && local(a) != local(b) {
				return local(a) < local(b)
			}
			if ua, ub := utilization(a), utilization(b); ua != ub {
				return ua < ub
			}
			if local(a) != local(b) {
				return local(a) < local(b)
			}
			return refNum(a.ID) < refNum(b.ID)
		})
		return Choice{Kind: "run", Host: ready[0].ID}
	}
	if localLater != "" {
		return Choice{Kind: "queue", Reason: localLater, Held: localHeld}
	}
	if laterReason != "" {
		return Choice{Kind: "queue", Reason: laterReason, Held: laterHeld}
	}
	if localNever == "" {
		localNever = "本机接不了"
	}
	return Choice{Kind: "refuse", Reason: localNever + "，也没有别的机器能接"}
}

func refNum(id string) int {
	n, _ := strconv.Atoi(strings.TrimLeft(id, "abcdefghijklmnopqrstuvwxyz"))
	return n
}

// ---- 日志续传与重连对账 ----

// LogAccept 判代理传来的一段日志（按远程日志文件的字节偏移）。expected 是服务已收到的位置：
// 正好接上整段写；有重叠跳过已有的前缀；有缺口拒收（gap），让代理从 expected 重传；全是旧的（stale）不写。
func LogAccept(expected, offset, length int64) (skip int64, verdict string) {
	switch {
	case offset > expected:
		return 0, "gap"
	case expected-offset >= length:
		return 0, "stale"
	}
	return expected - offset, "append"
}

// RunRef 是一次远程运行：任务 + 第几轮。
type RunRef struct {
	Task string `json:"task"`
	Run  int    `json:"run"`
}

// AgentRun 是代理手上的一次运行。
type AgentRun struct {
	RunRef
	Running bool `json:"running"`
}

// Reconcile 重连对账：lost 是账上在这台跑、代理却不知道的（代理数据丢了，按退出不明收尾）；
// orphans 是代理还在跑、账上已不认的（任务结束或换了一轮），让代理结束它。已退出的由代理补报。
func Reconcile(server []RunRef, agent []AgentRun) (lost []RunRef, orphans []RunRef) {
	known := map[RunRef]bool{}
	for _, a := range agent {
		known[a.RunRef] = true
	}
	expected := map[RunRef]bool{}
	for _, s := range server {
		expected[s] = true
		if !known[s] {
			lost = append(lost, s)
		}
	}
	for _, a := range agent {
		if a.Running && !expected[a.RunRef] {
			orphans = append(orphans, a.RunRef)
		}
	}
	return lost, orphans
}

// Backoff 是代理断线重连的等待：1、2、4… 秒，封顶 15 秒。
func Backoff(attempt int) int64 { return min(15_000, int64(1000)<<min(max(attempt, 0), 10)) }

// ---- 参数校验 ----

var (
	namePattern  = regexp.MustCompile(`^[^\s\x00-\x1f][^\x00-\x1f]{0,39}$`)
	repoPattern  = regexp.MustCompile(`^(\*|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)$`)
	sshPattern   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$`)
	tunnelPatten = regexp.MustCompile(`^([1-9][0-9]{0,4}):([1-9][0-9]{0,4})$`)
)

// AddInput 是 host add 的参数。
type AddInput struct {
	Name   string   `json:"name"`
	Repos  []string `json:"repos"`
	Max    int      `json:"max"`
	SSH    string   `json:"ssh"`
	Tunnel string   `json:"tunnel"` // 本机端口:远端端口；带 --ssh 时缺省为服务端口:服务端口
	Key    string   `json:"key"`    // 隧道用的私钥（绝对路径）：服务环境里没有 ssh-agent，只能 ssh -i
}

// Validate 校验并整理 host add 的参数；返回隧道两端端口（没有 --ssh 为 0）。
func (in *AddInput) Validate(servicePort int) (local, remote int, err error) {
	in.Name = strings.TrimSpace(in.Name)
	if !namePattern.MatchString(in.Name) {
		return 0, 0, api.Usage("名称：1 到 40 个字，不能以空白开头")
	}
	seen := map[string]bool{}
	var repos []string
	for _, r := range in.Repos {
		r = strings.TrimSpace(r)
		if r == "" || seen[r] {
			continue
		}
		if !repoPattern.MatchString(r) {
			return 0, 0, api.Usage("--repo: 应为 owner/name 或 *，收到 %q", r)
		}
		seen[r] = true
		repos = append(repos, r)
	}
	if len(repos) > 50 {
		return 0, 0, api.Usage("--repo: 最多登记 50 个")
	}
	in.Repos = repos
	if in.Repos == nil {
		in.Repos = []string{}
	}
	if in.Max < 0 || in.Max > 64 {
		return 0, 0, api.Usage("--max: 应为 1 到 64 的整数")
	}
	if in.SSH == "" {
		if in.Tunnel != "" {
			return 0, 0, api.Usage("--tunnel: 要和 --ssh 一起给")
		}
		if in.Key != "" {
			return 0, 0, api.Usage("--key: 要和 --ssh 一起给")
		}
		return 0, 0, nil
	}
	if in.Key != "" && (!filepath.IsAbs(in.Key) || strings.ContainsAny(in.Key, "\x00\n\r")) {
		return 0, 0, api.Usage("--key: 应为私钥文件的绝对路径")
	}
	if !sshPattern.MatchString(in.SSH) || strings.Contains(in.SSH, "..") {
		return 0, 0, api.Usage("--ssh: 应为 user@地址（不含空格或选项）")
	}
	if in.Tunnel == "" {
		in.Tunnel = fmt.Sprintf("%d:%d", servicePort, servicePort)
	}
	m := tunnelPatten.FindStringSubmatch(in.Tunnel)
	if m == nil {
		return 0, 0, api.Usage("--tunnel: 应为本机端口:远端端口，端口 1–65535")
	}
	local, _ = strconv.Atoi(m[1])
	remote, _ = strconv.Atoi(m[2])
	if local > 65535 || remote > 65535 {
		return 0, 0, api.Usage("--tunnel: 端口应在 1–65535")
	}
	return local, remote, nil
}

// TunnelArgs 是 ssh 反向隧道的参数：远端 127.0.0.1:remote 转回服务这台的 127.0.0.1:local。
// 给了私钥就只用它（-i 加 IdentitiesOnly）：服务环境里没有 SSH_AUTH_SOCK。
func TunnelArgs(target, key string, local, remote int) []string {
	var id []string
	if key != "" {
		id = []string{"-i", key, "-o", "IdentitiesOnly=yes"}
	}
	return append(append([]string{"-N", "-T"}, id...),
		"-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
		"-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
		"-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes",
		"-R", fmt.Sprintf("127.0.0.1:%d:127.0.0.1:%d", remote, local), target)
}

// TunnelDelay 是隧道断开后重连的等待：1、2、4… 秒，封顶 60 秒。
func TunnelDelay(attempt int) int64 { return min(60_000, int64(1000)<<min(max(attempt, 0), 6)) }

// CloneName 是代理上克隆目录名：取远端地址最后两段（owner-name），只留安全字符。
func CloneName(url string) string {
	u := strings.TrimSuffix(strings.TrimRight(strings.TrimSpace(url), `/\`), ".git")
	parts := strings.FieldsFunc(u, func(r rune) bool { return r == '/' || r == '\\' || r == ':' })
	if len(parts) > 2 {
		parts = parts[len(parts)-2:]
	}
	name := regexp.MustCompile(`[^A-Za-z0-9._-]+`).ReplaceAllString(strings.Join(parts, "-"), "-")
	name = strings.Trim(name, "-.")
	if name == "" {
		return "repo"
	}
	return name
}

var branchPattern = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)

// AssignmentRefusal 是代理这一侧对拉起指令的核对：代理只照做合法的指令（纯函数）。
func AssignmentRefusal(a Assignment, knownTool func(string) bool) string {
	switch {
	case !api.IsRef(a.Task, "t"):
		return "任务号不合法"
	case a.Run < 1:
		return "轮号不合法"
	case !knownTool(a.Tool):
		return "不认识的执行者工具：" + a.Tool
	case strings.TrimSpace(a.Request.Prompt) == "":
		return "提示词为空"
	}
	if a.Repo != "" {
		if strings.HasPrefix(a.Repo, "-") || strings.ContainsAny(a.Repo, " \t\r\n") {
			return "仓库地址不合法"
		}
		for _, b := range []string{a.Branch, a.Base} {
			if !branchPattern.MatchString(b) || strings.HasPrefix(b, "-") || strings.Contains(b, "..") {
				return "分支名不合法：" + b
			}
		}
	}
	for k, v := range a.Env {
		if !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`).MatchString(k) || strings.HasPrefix(k, "ATRIUM_") || strings.ContainsRune(v, 0) {
			return "凭据名称不合法：" + k
		}
	}
	return ""
}

// readGit 是代理替服务跑的 git 子命令：只查不改（fetch 只更新远端跟踪分支，交付检查要拿它比默认分支）。
var readGit = map[string]bool{"rev-parse": true, "status": true, "log": true, "diff": true, "rev-list": true,
	"ls-remote": true, "fetch": true}

// gitDenied 是只读子命令里也会写文件或拉起程序的选项前缀（-u 即 ls-remote/fetch 的 --upload-pack）。
var gitDenied = []string{"--output", "--upload-pack", "--exec", "--ext-diff", "-u", "-o"}

// QueryRefusal 是代理这一侧对查询的核对（纯函数）：目录只能是代理数据目录 root 下 repos/、tasks/ 里的；
// git 只跑 readGit 里的子命令（前面可带 --no-optional-locks），读文件只读目录根下一个不隐藏的文件。
func QueryRefusal(root string, q Query) string {
	rel, err := filepath.Rel(root, q.Dir)
	parts := strings.Split(filepath.ToSlash(rel), "/")
	switch {
	case !filepath.IsAbs(q.Dir) || filepath.Clean(q.Dir) != q.Dir || err != nil:
		return "目录不合法：" + q.Dir
	case len(parts) < 2 || (parts[0] != "repos" && parts[0] != "tasks") || strings.Contains(rel, ".."):
		return "目录不在代理的工作目录里：" + q.Dir
	case (len(q.Git) > 0) == (q.File != ""):
		return "git 与 file 要且只要一个"
	case q.File != "":
		if filepath.Base(q.File) != q.File || strings.HasPrefix(q.File, ".") || strings.ContainsAny(q.File, `/\:`) {
			return "文件名不合法：" + q.File
		}
		return ""
	}
	args := q.Git
	if args[0] == "--no-optional-locks" {
		args = args[1:]
	}
	if len(args) == 0 || !readGit[args[0]] {
		return "只跑只读的 git 子命令，收到：" + strings.Join(firstArgs(q.Git, 2), " ")
	}
	for _, a := range args[1:] {
		for _, d := range gitDenied {
			if strings.HasPrefix(a, d) {
				return "git 选项不允许：" + a
			}
		}
	}
	return ""
}

func firstArgs(s []string, n int) []string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
