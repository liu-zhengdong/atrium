// Package secretary：秘书桥与状态栏。
//
// secretary bridge 在 Claude Code 秘书会话里常驻：挂 events wait --as secretary 取要处理的事件，
// 攒 30 秒拼成一条「【Atrium 事件】」消息经会话收件 socket 注入；不替秘书确认；同一事件送过不重送，
// 送过 30 分钟没确认再提醒一次；每 30 秒向服务报「秘书在听」；会话关了就退出（判定见 Liveness：
// 收件地址不在了立即退出，地址还在但连不上要连续 2 分钟；没送进去的留着下一轮重送）。
// Pi 会话连得上但拒收（重载换了口令）不算连不上：按收件地址重读一次口令重送，仍拒收就退出。
// 最近一次投递失败的原因与时刻记在登记里（每次失败都更新时刻），--status 先报它、分在重试与已退出，送成功后清掉；
// 带着失败退出时登记留给 --status 看，下一个 bridge 起来时覆盖。
// statusline 给 Claude Code 状态栏一行字；服务不在只显示「未运行」，不拉起。
// --install-hook 同时在项目设置 env 里写 ATRIUM_AS=secretary：秘书会话发的命令署名秘书（权限同用户）。
// --detach 起好后再输出根部门要点、此刻全景与秘书备忘（Brief）：hook 的输出进会话上下文，进展以账本为准，备忘不记进展。
// 判定在 plan.go、statusline.go（纯函数）。
package secretary

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/watch"
)

// Module 是本包接入点：只有命令（在听状态、事件都在 events 包的接口里）。
func Module() app.Module { return app.Module{Name: "secretary", Commands: Commands} }

func Commands(t *cli.Table) {
	t.Group("secretary", "秘书")
	t.Add(cli.Command{Path: "secretary bridge",
		Summary: "在秘书会话里常驻，把要处理的事件注入会话；Claude Code 用 --install-hook 随会话自动起，Pi 由扩展用 --pi 起",
		Flags: []cli.Flag{
			{Name: "detach", Bool: true, Help: "后台起（SessionStart hook 与 Pi 扩展用），起好后输出根部门要点、此刻全景与秘书备忘就返回"},
			{Name: "install-hook", Bool: true, Help: "在秘书目录的 .claude/settings.local.json 加 SessionStart hook 与 env ATRIUM_AS=secretary（命令署名秘书）"},
			{Name: "dir", Value: "目录", Help: "--install-hook 的秘书目录（缺省当前目录）"},
			{Name: "pi", Value: "会话", Help: "Pi 秘书会话：pid、名字或会话 id 前缀（读 ~/.pi/agent/inbox 里的登记）"},
			{Name: "stop", Bool: true, Help: "停掉在跑的 bridge 让出收件地址（Pi 里 /secretary off 用）"},
			{Name: "status", Bool: true, Help: "看 bridge 在不在跑、秘书在不在听"},
			{Name: "batch", Value: "秒", Help: "首条事件到了之后攒多久再送（缺省 30）"},
		},
		Run: bridgeCommand})
	// statusline 由 Claude Code 状态栏调用（settings.json 的 statusLine），不是人敲的：不列在帮助里。
	t.Add(cli.Command{Path: "statusline", Summary: "一行状态给 Claude Code 状态栏：等你拍板、未结束任务在等谁、秘书在不在听", Hidden: true,
		Run: func(c *cli.Ctx) error {
			var v watch.View
			var err error
			if c.JSON {
				err = c.Call("GET", "/api/top", nil, &v)
			} else {
				v, err = watch.ReadHumanView(c)
			}
			var ae *api.Error
			if errors.As(err, &ae) && ae.Code == "not_running" {
				return c.Done(map[string]any{"running": false}, "Atrium 未运行", "")
			}
			if err != nil {
				return err
			}
			if c.JSON {
				return c.Done(v, "", "atrium top")
			}
			fmt.Fprintln(c.Env.Stdout, StatusLine(v))
			return nil
		}})
}

func bridgeCommand(c *cli.Ctx) error {
	if err := c.MaxArgs(0); err != nil {
		return err
	}
	modes := 0
	for _, m := range []string{"detach", "install-hook", "status", "stop"} {
		if c.Bool(m) {
			modes++
		}
	}
	if modes > 1 {
		return api.Usage("--detach、--install-hook、--status、--stop 只能给一个")
	}
	if c.Has("dir") && !c.Bool("install-hook") {
		return api.Usage("--dir: 只和 --install-hook 一起用")
	}
	if c.Has("pi") && (c.Bool("install-hook") || c.Bool("status") || c.Bool("stop")) {
		return api.Usage("--pi: 只和 --detach 一起用（或单独跑 bridge）")
	}
	batch, err := c.Int("batch", int(BatchWindow.Seconds()))
	if err != nil {
		return err
	}
	if batch < 0 || batch > 600 {
		return api.Usage("--batch: 应为 0–600 的秒数")
	}
	switch {
	case c.Bool("install-hook"):
		return installHook(c)
	case c.Bool("status"):
		return status(c)
	case c.Bool("stop"):
		return bridgeStop(c)
	}
	in, err := resolveInbox(c)
	if err != nil {
		return err
	}
	p, err := c.Paths()
	if err != nil {
		return err
	}
	if c.Bool("detach") {
		return detach(c, p, in, batch)
	}
	return foreground(c, p, in, time.Duration(batch)*time.Second)
}

// inbox 是秘书会话的收件地址。两种会话的协议不同：Pi 逐条回执（platform/piinbox.go），Claude Code 只收不回。
type inbox struct {
	kind     string // kindPi 或 kindClaude
	endpoint string
	token    string
}

const (
	kindPi     = "pi"
	kindClaude = "claude-code"
	// Pi 收件地址与口令：Pi 扩展（/secretary on）起 bridge 时写进环境，bridge 再传给它自己的子进程。
	piInboxEnv = "ATRIUM_PI_INBOX"
	piTokenEnv = "ATRIUM_PI_TOKEN"
)

// resolveInbox 定这次 bridge 往哪送：--pi 指名本机一个 Pi 会话，否则从环境变量认本会话的收件地址。
func resolveInbox(c *cli.Ctx) (inbox, error) {
	if q := c.Str("pi"); q != "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return inbox{}, err
		}
		list, err := platform.ListPiInbox(home)
		if err != nil {
			return inbox{}, err
		}
		hit, err := MatchPiInbox(list, q)
		if err != nil {
			return inbox{}, err
		}
		token, err := hit.Token()
		if err != nil {
			return inbox{}, api.Usage("Pi 会话 %d 的口令读不出：%v", hit.PID, err)
		}
		return inbox{kind: kindPi, endpoint: hit.Socket, token: token}, nil
	}
	return sessionInbox(runtime.GOOS, c.Env.Getenv)
}

// sessionInbox 读本会话的收件地址与口令：Claude Code 的在 hook 与 Bash 子进程里有，Pi 的由扩展起 bridge 时写进环境。
func sessionInbox(goos string, getenv func(string) string) (inbox, error) {
	if endpoint, token := getenv(piInboxEnv), getenv(piTokenEnv); endpoint != "" && token != "" {
		return inbox{kind: kindPi, endpoint: endpoint, token: token}, nil
	}
	raw, token := getenv("CLAUDE_CODE_MESSAGING_SOCKET"), getenv("CLAUDE_CODE_MESSAGING_TOKEN")
	if raw == "" || token == "" {
		return inbox{}, api.Usage("不在秘书会话里：没有 %s/%s（Pi 会话里先 /secretary on）也没有 CLAUDE_CODE_MESSAGING_SOCKET/CLAUDE_CODE_MESSAGING_TOKEN", piInboxEnv, piTokenEnv)
	}
	endpoint := platform.MessagingEndpoint(goos, raw)
	if endpoint == "" {
		return inbox{}, api.Usage("CLAUDE_CODE_MESSAGING_SOCKET 认不出：%q", raw)
	}
	return inbox{kind: kindClaude, endpoint: endpoint, token: token}, nil
}

// ---- 登记（数据目录 secretary/bridge.json）----

func recordPath(p config.Paths) string { return filepath.Join(p.Data, "secretary", "bridge.json") }
func logPath(p config.Paths) string    { return filepath.Join(p.Data, "secretary", "bridge.log") }

func readRecord(p config.Paths) (*Record, error) {
	raw, err := os.ReadFile(recordPath(p))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var r Record
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("%s 不是合法 JSON：%w", recordPath(p), err)
	}
	return &r, nil
}

func writeRecord(p config.Paths, r Record) error {
	if err := os.MkdirAll(filepath.Dir(recordPath(p)), 0o700); err != nil {
		return err
	}
	raw, _ := json.Marshal(r)
	tmp := recordPath(p) + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, recordPath(p))
}

// releaseRecord：登记还是自己时才删，别的会话接手后留给它。
func releaseRecord(p config.Paths, pid int) {
	if r, err := readRecord(p); err == nil && r != nil && r.PID == pid {
		os.Remove(recordPath(p))
	}
}

// ---- 前台常驻 ----

func foreground(c *cli.Ctx, p config.Paths, in inbox, batch time.Duration) error {
	cur, err := readRecord(p)
	if err != nil {
		return err
	}
	if cur != nil && cur.PID != os.Getpid() && Claim(cur, in.endpoint, platform.Alive) == "running" {
		return api.Conflict("本会话的 bridge 已在跑（pid %d）", cur.PID).WithNext("atrium secretary bridge --status")
	}
	var home string
	if in.kind == kindPi {
		if home, err = os.UserHomeDir(); err != nil {
			return err
		}
	}
	me := os.Getpid()
	if err := writeRecord(p, Record{PID: me, Socket: in.endpoint, Kind: in.kind, StartedAt: store.Now()}); err != nil {
		return err
	}
	lg := log.New(c.Env.Stderr, "", log.LstdFlags)
	b := &bridge{c: c, p: p, in: in, home: home, me: me, log: lg, sent: Sent{}, batch: batch}
	defer b.release()
	ctx, stop := signal.NotifyContext(c.Context, os.Interrupt, syscall.SIGTERM)
	defer stop()
	c.Context = ctx // 收到结束信号时打断挂着的 events wait
	lg.Printf("bridge 开始（pid %d，%s 会话，收件地址 %s）", me, in.kind, in.endpoint)
	reason := b.run(ctx)
	lg.Printf("bridge 退出：%s", reason)
	return c.Done(map[string]any{"reason": reason}, "bridge 已退出："+reason, "atrium secretary bridge --status")
}

type bridge struct {
	c       *cli.Ctx
	p       config.Paths
	in      inbox
	home    string // 重读 Pi 口令时找 pi-inbox 登记
	me      int
	log     *log.Logger
	sent    Sent
	batch   time.Duration
	live    Liveness
	failure string // 已记进登记的最近一次投递失败
}

// closed 记一次连会话的结果（探测或送入），返回退出原因；空串是会话还在。连不上与恢复各记一行日志。
func (b *bridge) closed(err error) string {
	wasDown := b.live.Down()
	reason := b.live.Observe(time.Now(), err)
	switch {
	case reason != "":
	case err != nil && !wasDown:
		b.log.Printf("连不上会话，稍后重试（连续 %d 分钟连不上才算会话已关闭）：%v", int(SessionDownAfter.Minutes()), err)
	case err == nil && wasDown:
		b.log.Printf("会话又连上了")
	}
	return reason
}

func (b *bridge) listen(stop bool) error {
	return b.c.Call("POST", "/api/events/listen",
		events.ListenBody{As: events.Secretary, Via: kindText(b.in.kind) + " 会话，经注入", TTLSeconds: ListenTTL, Stop: stop}, nil)
}

func (b *bridge) run(ctx context.Context) string {
	go func() {
		t := time.NewTicker(ListenEvery)
		defer t.Stop()
		failed := false
		for {
			if err := b.listen(false); err != nil {
				if !failed {
					b.log.Printf("向服务报「在听」失败：%v", err)
				}
				failed = true
				b.c.ResetClient()
			} else if failed {
				b.log.Printf("已重新向服务报「在听」")
				failed = false
			}
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		b.c.Context = ctx
		b.listen(true)
	}()
	var pending []events.Row
	var first time.Time
	for {
		if ctx.Err() != nil {
			return "已停止"
		}
		if r, err := readRecord(b.p); err == nil && r != nil && r.PID != b.me {
			return "另一个秘书会话的 bridge 已接手"
		}
		if reason := b.closed(platform.ProbeEndpoint(b.in.endpoint, 3*time.Second)); reason != "" {
			return reason
		}
		wait := 60 * time.Second
		if len(pending) > 0 {
			wait = max(time.Until(first.Add(b.batch)), 0)
		}
		var rows []events.Row
		q := url.Values{"as": {events.Secretary}, "timeout": {fmt.Sprint(int(wait.Seconds()))}}
		if err := b.c.Call("GET", "/api/events/wait?"+q.Encode(), nil, &rows); err != nil {
			if ctx.Err() != nil {
				return "已停止"
			}
			b.log.Printf("取事件失败，5 秒后重试：%v", err)
			b.c.ResetClient()
			sleep(ctx, 5*time.Second)
			continue
		}
		if len(rows) > 0 && len(pending) == 0 {
			first = time.Now()
		}
		pending = Merge(pending, rows)
		if len(pending) == 0 || time.Since(first) < b.batch {
			continue
		}
		batch := PlanBatch(b.sent, pending, store.Now(), RemindAfter)
		if batch.Empty() {
			pending = nil
			continue
		}
		names, err := events.ReadNames(b.c)
		if err != nil {
			return fmt.Sprintf("读取负责人名册失败：%v", err)
		}
		err = b.send(Prompt(batch, store.Now(), RemindAfter, names))
		b.noteDelivery(err)
		if errors.Is(err, platform.ErrPiRejected) {
			// 连得上但拒收，不进 Liveness 计时（2 分钟连不上的判定对它永不触发）；send 已重读口令重试过。
			return fmt.Sprintf("会话拒收，重读口令后仍送不进（%v）；在秘书会话里 /secretary on 重新接手", err)
		}
		if reason := b.closed(err); reason != "" {
			return reason
		}
		if err != nil {
			// 没送进去：留在 pending，5 秒后下一轮重送（不等租约到期重投）。
			b.log.Printf("送入会话失败，5 秒后重送：%v", err)
			sleep(ctx, 5*time.Second)
			continue
		}
		pending = nil
		all := append(append([]events.Row{}, batch.Fresh...), batch.Remind...)
		b.sent.Record(all, store.Now())
		b.log.Printf("送入 %d 条（其中再提醒 %d 条）", len(all), len(batch.Remind))
	}
}

// send 把一批事件送进会话：Pi 走 pi-inbox 协议（逐条读回执），Claude Code 只写完不回执。
// Pi 会话重载会换口令（收件地址不变）：被拒收就按收件地址重读一次口令再送；仍不行返回包着 platform.ErrPiRejected 的错误。
func (b *bridge) send(text string) error {
	if b.in.kind != kindPi {
		return platform.SendLines(b.in.endpoint, InboxLines(b.in.token, text), 5*time.Second)
	}
	err := platform.SendPiMessages(b.in.endpoint, b.in.token, []string{text}, 5*time.Second)
	if !errors.Is(err, platform.ErrPiRejected) {
		return err
	}
	token, rerr := platform.PiTokenFor(b.home, b.in.endpoint)
	if rerr != nil {
		return fmt.Errorf("%w；重读口令失败：%v", err, rerr)
	}
	b.in.token = token
	if err2 := platform.SendPiMessages(b.in.endpoint, token, []string{text}, 5*time.Second); err2 != nil {
		return fmt.Errorf("%w；重读口令后重送：%v", err, err2)
	}
	b.log.Printf("会话拒收（%v），已从 pi-inbox 登记重读口令，重送成功", err)
	return nil
}

// release 退出时让出登记；最近一次投递失败时留着登记，--status 仍能报出失败原因与时刻（下一个 bridge 起来时覆盖）。
func (b *bridge) release() {
	if b.failure == "" {
		releaseRecord(b.p, b.me)
	}
}

// noteDelivery 把投递结果记进登记供 --status 看：每次失败都记原因与此刻，成功时清掉（本来没失败就不写）。登记已换人时不动。
func (b *bridge) noteDelivery(err error) {
	failure := ""
	if err != nil {
		failure = err.Error()
	}
	if failure == "" && b.failure == "" {
		return
	}
	r, rerr := readRecord(b.p)
	if rerr != nil || r == nil || r.PID != b.me {
		return
	}
	r.Failure, r.FailedAt = failure, 0
	if err != nil {
		r.FailedAt = store.Now()
	}
	if werr := writeRecord(b.p, *r); werr != nil {
		b.log.Printf("投递结果记不进登记：%v", werr)
		return
	}
	b.failure = failure
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// ---- 后台起（SessionStart hook）----

func detach(c *cli.Ctx, p config.Paths, in inbox, batch int) error {
	cur, err := readRecord(p)
	if err != nil {
		return err
	}
	brief, err := sessionBrief(c)
	if err != nil {
		return err
	}
	if Claim(cur, in.endpoint, platform.Alive) == "running" {
		return c.Done(cur, fmt.Sprintf("Atrium bridge 已在跑（pid %d）：要处理的事件以「【Atrium 事件】」消息送进本会话，处理完 atrium events ack <编号>。%s\n\n%s", cur.PID, WorkStyle, brief),
			"atrium secretary bridge --status")
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(logPath(p)), 0o700); err != nil {
		return err
	}
	lf, err := os.OpenFile(logPath(p), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer lf.Close()
	// bridge 要会话收件地址与数据目录，环境原样带上（它不是执行者）；Pi 的收件地址不在当前环境里，显式传给它。
	env := platform.EnvMap(os.Environ())
	if in.kind == kindPi {
		env[platform.EnvKey(runtime.GOOS, piInboxEnv)] = in.endpoint
		env[platform.EnvKey(runtime.GOOS, piTokenEnv)] = in.token
	}
	cmd, err := platform.Start(platform.Spec{Path: self, Args: []string{"secretary", "bridge", "--batch", fmt.Sprint(batch)},
		Env: env, Stdout: lf, Stderr: lf, Detached: true})
	if err != nil {
		return err
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-exited:
			return fmt.Errorf("bridge 没起来（%v）；看日志：%s", err, logPath(p))
		case <-time.After(100 * time.Millisecond):
		}
		if r, _ := readRecord(p); r != nil && r.PID == cmd.Process.Pid {
			return c.Done(r, fmt.Sprintf("Atrium bridge 已在后台运行（pid %d）：秘书要处理的事件会以「【Atrium 事件】」开头的消息送进本会话，处理完用 atrium events ack <编号> 确认。%s日志：%s\n\n%s", r.PID, WorkStyle, logPath(p), brief),
				"atrium secretary bridge --status")
		}
	}
	return fmt.Errorf("bridge 10 秒内没登记上；看日志：%s", logPath(p))
}

// WorkStyle 是秘书会话开头的工作方式：秘书要随时能被用户插话，不在前台干等。
const WorkStyle = "超过半分钟的命令（构建、渲染、部署、等外部结果）一律放后台跑，完成通知回来再核对；分派任务、合入后不用守着：失败、受阻、等验收会作为事件送来，完成只记知会（events wait --all 或网页今天页看）。"

// sessionBrief 取用户全局原则（bridge 与服务在同一台机器，现读本机的 ~/AGENTS.md）、技能索引、根部门要点、全景与秘书备忘，拼成会话开头的一段（SessionStart hook 的输出进会话上下文）。
// 只取顶层部门自己的要点（秘书在组织树之上，下属部门的规矩管的是负责人与执行者）。
func sessionBrief(c *cli.Ctx) (string, error) {
	var roots []*org.Node
	if err := c.Call("GET", "/api/org", nil, &roots); err != nil {
		return "", err
	}
	var points []org.Point
	for _, r := range roots {
		var s org.Show
		if err := c.Call("GET", "/api/org/"+url.PathEscape(r.ID), nil, &s); err != nil {
			return "", err
		}
		points = append(points, s.Points...)
	}
	v, err := watch.ReadHumanView(c)
	if err != nil {
		return "", err
	}
	var m struct {
		Body string `json:"body"`
	}
	if err := c.Call("GET", "/api/memo?as="+events.Secretary, nil, &m); err != nil {
		return "", err
	}
	global, err := org.Principles()
	if err != nil {
		return "", err
	}
	var skills []org.Skill
	if err := c.Call("GET", "/api/skills", nil, &skills); err != nil {
		return "", err
	}
	return Brief(global, org.SkillIndex(skills, ""), points, v, m.Body), nil
}

// ---- --status 与 --install-hook ----

func status(c *cli.Ctx) error {
	p, err := c.Paths()
	if err != nil {
		return err
	}
	cur, err := readRecord(p)
	if err != nil {
		return err
	}
	alive := cur != nil && platform.Alive(cur.PID)
	var out struct {
		Listener *events.Listener `json:"listener"`
	}
	if err := c.Call("GET", "/api/events/listen?as=secretary", nil, &out); err != nil {
		return err
	}
	text, next := statusText(cur, alive, out.Listener, logPath(p))
	if !alive && (cur == nil || cur.Failure == "") {
		cur = nil
	}
	return c.Done(map[string]any{"listener": out.Listener, "bridge": cur, "running": alive}, text, next)
}

// statusText 判定 --status 说什么：最近一次投递失败优先（分 bridge 在重试与已退出），其次服务那边的「在听」，再次 bridge 进程在不在。
func statusText(cur *Record, alive bool, l *events.Listener, logFile string) (text, next string) {
	if cur != nil && cur.Failure != "" {
		at := time.UnixMilli(cur.FailedAt).Format("01-02 15:04:05")
		if alive {
			return fmt.Sprintf("最近一次投递失败（%s）：%s；bridge pid %d（%s 会话）在重试，事件没进会话；看日志：%s",
				at, cur.Failure, cur.PID, kindText(cur.Kind), logFile), "atrium secretary bridge --status"
		}
		return fmt.Sprintf("bridge 已退出（pid %d，%s 会话），退出前最近一次投递失败（%s）：%s；事件没进会话，在秘书会话里重新起 bridge（Pi：/secretary on）；看日志：%s",
			cur.PID, kindText(cur.Kind), at, cur.Failure, logFile), "atrium events wait --timeout 0"
	}
	switch {
	case l != nil:
		text := fmt.Sprintf("秘书在听（%s）", l.Via)
		if alive {
			text += fmt.Sprintf(" · bridge pid %d（%s 会话）", cur.PID, kindText(cur.Kind))
		}
		return text, "atrium events wait --timeout 0"
	case alive:
		return fmt.Sprintf("bridge 在跑（pid %d），但还没向服务报「在听」；看日志：%s", cur.PID, logFile), "atrium secretary bridge --status"
	}
	return "没有 bridge 在听：秘书会话收不到注入的事件", "atrium secretary bridge --install-hook"
}

// kindText 把登记里的会话种类写成人看的话（早期登记没有这个字段，那时只有 Claude Code 一种）。
func kindText(kind string) string {
	if kind == kindPi {
		return "Pi"
	}
	return "Claude Code"
}

// bridgeStop 停掉登记里的 bridge 并清登记：Pi 里 /secretary off 靠它让出收件地址（Claude Code 的 bridge 随会话退出，不用停）。
func bridgeStop(c *cli.Ctx) error {
	p, err := c.Paths()
	if err != nil {
		return err
	}
	cur, err := readRecord(p)
	if err != nil {
		return err
	}
	if cur == nil || !platform.Alive(cur.PID) {
		if cur != nil {
			releaseRecord(p, cur.PID)
		}
		return c.Done(map[string]any{"stopped": false}, "没有 bridge 在跑", "atrium secretary bridge --status")
	}
	if err := platform.KillTree(cur.PID); err != nil {
		return fmt.Errorf("停不掉 pid %d：%w；看日志：%s", cur.PID, err, logPath(p))
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && platform.Alive(cur.PID) {
		time.Sleep(100 * time.Millisecond)
	}
	releaseRecord(p, cur.PID)
	return c.Done(map[string]any{"stopped": true, "pid": cur.PID, "socket": cur.Socket},
		fmt.Sprintf("已停 bridge（pid %d，%s 会话）：收件地址让出，别的会话用 /secretary on 接手", cur.PID, kindText(cur.Kind)),
		"atrium secretary bridge --status")
}

func installHook(c *cli.Ctx) error {
	dir := c.Str("dir")
	if dir == "" {
		wd, err := os.Getwd()
		if err != nil {
			return err
		}
		dir = wd
	}
	file := filepath.Join(dir, ".claude", "settings.local.json")
	var settings map[string]any
	raw, err := os.ReadFile(file)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return err
	case len(raw) > 0:
		if err := json.Unmarshal(raw, &settings); err != nil {
			hook, _ := json.Marshal(HookEntry())
			return api.Conflict("%s 不是 JSON 对象，没有改动；手动在 hooks.SessionStart 里加入：%s，在 env 里加 %s=%s", file, hook, AsEnv, events.Secretary)
		}
	}
	next, added, err := WithHook(settings)
	if err != nil {
		return api.Conflict("%s：%v", file, err)
	}
	res := map[string]any{"file": file, "added": added, "hook": HookEntry(), "env": map[string]string{AsEnv: events.Secretary}}
	if !added {
		return c.Done(res, file+" 里已有起 bridge 的 SessionStart hook 与 "+AsEnv+"，没有改动", "atrium secretary bridge --status")
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return err
	}
	out, _ := json.MarshalIndent(next, "", "  ")
	if err := os.WriteFile(file, append(out, '\n'), 0o644); err != nil {
		return err
	}
	return c.Done(res, fmt.Sprintf("已在 %s 加 SessionStart hook（%s）与 env %s=%s。之后在 %s 打开的 Claude Code 会话都会在后台起 bridge，会话里的命令署名秘书。当前会话：运行 %s 马上起 bridge，署名要重开会话才生效",
		file, HookCommand, AsEnv, events.Secretary, dir, HookCommand), "atrium secretary bridge --status")
}
