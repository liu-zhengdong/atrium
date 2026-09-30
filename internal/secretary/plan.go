package secretary

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/watch"
)

// 桥的节奏。
const (
	BatchWindow = 30 * time.Second // 首条到了之后攒多久再送
	RemindAfter = 30 * time.Minute // 送过这么久没确认、又被重投回来的再提醒一次
	ListenEvery = 30 * time.Second // 多久向服务报一次「在听」
	ListenTTL   = 90               // 「在听」的有效秒数
	sentLimit   = 1000             // 送过的记录上限

	SessionDownAfter = 2 * time.Minute // 收件地址还在但一直连不上，满这么久才算会话已关闭
)

// Liveness 按一次次连会话的结果（探测或送入）判会话关没关：收件地址不在了（platform.ErrEndpointGone）立即算关闭；
// 地址还在但连不上（服务重启时会话忙、对方暂时不接）要从第一次连不上起、中间没有一次连上，满 SessionDownAfter 才算。
type Liveness struct{ downSince time.Time }

// Observe 记一次结果（err 为 nil 是连上了），返回退出原因；空串是继续。
func (l *Liveness) Observe(now time.Time, err error) string {
	switch {
	case err == nil:
		l.downSince = time.Time{}
		return ""
	case errors.Is(err, platform.ErrEndpointGone):
		return fmt.Sprintf("会话已关闭（%v）", err)
	case l.downSince.IsZero():
		l.downSince = now
	}
	if now.Sub(l.downSince) >= SessionDownAfter {
		return fmt.Sprintf("会话已关闭（连续 %d 分钟连不上，最近一次：%v）", int(SessionDownAfter.Minutes()), err)
	}
	return ""
}

// Down 是眼下是否处在连不上的状态。
func (l *Liveness) Down() bool { return !l.downSince.IsZero() }

// Sent 是送过的事件：编号 → 送出时的更新时刻与送出时刻。
type Sent map[int64]SentMark

type SentMark struct{ UpdatedAt, SentAt int64 }

// Batch 是这一批要送的：新的（或合并了新情况的）与再提醒的。
type Batch struct {
	Fresh  []events.Row
	Remind []events.Row
}

func (b Batch) Empty() bool { return len(b.Fresh)+len(b.Remind) == 0 }

// PlanBatch：同一事件（编号 + 更新时刻）送过就不再送；送过满 remind 还没确认、又被重投回来的再提醒一次。
func PlanBatch(sent Sent, rows []events.Row, now int64, remind time.Duration) Batch {
	var b Batch
	for _, r := range rows {
		if r.AckedAt != nil {
			continue
		}
		before, ok := sent[r.ID]
		switch {
		case !ok || before.UpdatedAt != r.UpdatedAt:
			b.Fresh = append(b.Fresh, r)
		case now-before.SentAt >= remind.Milliseconds():
			b.Remind = append(b.Remind, r)
		}
	}
	return b
}

// Record 记下送过的；超过上限丢编号最小的。
func (s Sent) Record(rows []events.Row, now int64) {
	for _, r := range rows {
		s[r.ID] = SentMark{UpdatedAt: r.UpdatedAt, SentAt: now}
	}
	for len(s) > sentLimit {
		var oldest int64 = -1
		for id := range s {
			if oldest < 0 || id < oldest {
				oldest = id
			}
		}
		delete(s, oldest)
	}
}

// Merge 把新取到的并进待送的（同一编号取更新的那条）。
func Merge(pending, rows []events.Row) []events.Row {
	idx := map[int64]int{}
	for i, r := range pending {
		idx[r.ID] = i
	}
	for _, r := range rows {
		if i, ok := idx[r.ID]; ok {
			pending[i] = r
			continue
		}
		idx[r.ID] = len(pending)
		pending = append(pending, r)
	}
	return pending
}

// Prompt 是送进会话的一条消息：「【Atrium 事件】」开头，每条一行摘要，末尾给看详情与确认的命令。
func Prompt(b Batch, remind time.Duration) string {
	all := append(append([]events.Row{}, b.Fresh...), b.Remind...)
	minutes := int(remind.Minutes())
	var lines []string
	if len(b.Fresh) > 0 {
		lines = append(lines, fmt.Sprintf("【Atrium 事件】%d 条要处理：", len(b.Fresh)))
	} else {
		lines = append(lines, fmt.Sprintf("【Atrium 事件】提醒：%d 条送过 %d 分钟还没确认：", len(b.Remind), minutes))
	}
	for _, r := range b.Fresh {
		lines = append(lines, "- "+events.Line(r))
	}
	if len(b.Fresh) > 0 && len(b.Remind) > 0 {
		lines = append(lines, fmt.Sprintf("送过 %d 分钟还没确认：", minutes))
	}
	for _, r := range b.Remind {
		lines = append(lines, "- "+events.Line(r))
	}
	var ids, tasks []string
	seen := map[string]bool{}
	for _, r := range all {
		ids = append(ids, strconv.FormatInt(r.ID, 10))
		if r.Task != "" && !seen[r.Task] {
			seen[r.Task] = true
			tasks = append(tasks, "atrium task show "+r.Task)
		}
	}
	lines = append(lines, "")
	if len(tasks) > 0 {
		lines = append(lines, "看详情："+strings.Join(tasks, "；"))
	}
	lines = append(lines, "处理完确认：atrium events ack "+strings.Join(ids, " "))
	return strings.Join(lines, "\n")
}

// InboxLines 是收件 socket 的两行：先认证，再一条用户消息。
func InboxLines(token, text string) []string {
	type message struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	auth, _ := json.Marshal(struct {
		Type  string `json:"type"`
		Token string `json:"token"`
	}{"auth", token})
	msg, _ := json.Marshal(struct {
		Type    string  `json:"type"`
		Message message `json:"message"`
	}{"user", message{"user", text}})
	return []string{string(auth), string(msg)}
}

// Record 是数据目录里登记的 bridge：同一时刻只有一个 bridge 往秘书会话送。
type Record struct {
	PID       int    `json:"pid"`
	Socket    string `json:"socket"`
	StartedAt int64  `json:"started_at"`
}

// Claim 判定起 bridge 前怎么办：同一会话的已在跑就不再起；别的会话的在跑，新的接手（旧的看到登记换了人就退出）。
func Claim(cur *Record, socket string, alive func(int) bool) string {
	if cur == nil || !alive(cur.PID) {
		return "start"
	}
	if cur.Socket == socket {
		return "running"
	}
	return "takeover"
}

// HookCommand 是 SessionStart hook 里跑的命令。
const HookCommand = "atrium secretary bridge --detach"

// WithHook 在 Claude Code 设置里加一条起 bridge 的 SessionStart hook，并在 env 里写 ATRIUM_AS=secretary
// （会话里发的命令署名秘书）；两样都有就不改，changed 为 false。
// 结构认不出（hooks、env 不是对象，SessionStart 不是数组）或 env.ATRIUM_AS 已是别的值时报错，不覆盖用户的内容。
func WithHook(settings map[string]any) (map[string]any, bool, error) {
	if settings == nil {
		settings = map[string]any{}
	}
	hooks, err := object(settings, "hooks")
	if err != nil {
		return nil, false, err
	}
	env, err := object(settings, "env")
	if err != nil {
		return nil, false, err
	}
	var groups []any
	if raw, ok := hooks["SessionStart"]; ok {
		g, ok := raw.([]any)
		if !ok {
			return nil, false, fmt.Errorf("设置里的 hooks.SessionStart 不是数组，没有改动")
		}
		groups = g
	}
	changed := false
	switch as, ok := env[AsEnv]; {
	case !ok:
		env[AsEnv] = events.Secretary
		changed = true
	case as != events.Secretary:
		return nil, false, fmt.Errorf("设置里的 env.%s 是 %v，不是 %s，没有改动", AsEnv, as, events.Secretary)
	}
	if !hasBridgeHook(groups) {
		hooks["SessionStart"] = append(groups, HookEntry())
		changed = true
	}
	settings["hooks"], settings["env"] = hooks, env
	return settings, changed, nil
}

// AsEnv 是命令行声明署名的环境变量（见 api.Sign）。
const AsEnv = "ATRIUM_AS"

func object(settings map[string]any, key string) (map[string]any, error) {
	raw, ok := settings[key]
	if !ok {
		return map[string]any{}, nil
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("设置里的 %s 不是对象，没有改动", key)
	}
	return m, nil
}

func hasBridgeHook(groups []any) bool {
	for _, g := range groups {
		gm, _ := g.(map[string]any)
		list, _ := gm["hooks"].([]any)
		for _, h := range list {
			hm, _ := h.(map[string]any)
			if cmd, _ := hm["command"].(string); strings.Contains(cmd, "atrium secretary bridge") {
				return true
			}
		}
	}
	return false
}

// HookEntry 是加进 hooks.SessionStart 的一组。
func HookEntry() map[string]any {
	return map[string]any{"hooks": []any{map[string]any{"type": "command", "command": HookCommand, "timeout": 30}}}
}

// Brief 是秘书会话开头看到的：用户的全局原则（org.Principles 拼好的一节）、根部门的要点（管到秘书自己）、此刻的全景（从账本现算）、记草稿的说明与秘书备忘。
// 进展只从全景读，备忘只记账本里没有的；都放进会话，新会话不用记得去查。没有全局原则、要点时不出那一节。
func Brief(global string, points []org.Point, v watch.View, memo string) string {
	if strings.TrimSpace(memo) == "" {
		memo = "（空）"
	}
	var b strings.Builder
	if global != "" {
		b.WriteString(global + "\n")
	}
	if len(points) > 0 {
		b.WriteString("组织要点（靠前的优先）：\n")
		for _, p := range points {
			b.WriteString("- " + org.ChainLine(p) + "\n")
		}
		b.WriteString("\n")
	}
	b.WriteString("此刻全景（atrium top）：\n" + watch.Render(v) + "\n\n记草稿：" + ledger.DraftHowTo + "\n\n秘书备忘（atrium memo show）：\n" + memo)
	return b.String()
}
