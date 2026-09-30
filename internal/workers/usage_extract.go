package workers

import (
	"math"
	"regexp"
	"strings"
)

// UsageSpec 声明从 JSON 日志哪条事件、哪个字段取用量；写在档案 usage: 下，不按工具写特判。
type UsageSpec struct {
	Event      string `yaml:"event,omitempty" json:"event,omitempty"` // 匹配事件的 type；空则每条 JSON 都看
	Input      string `yaml:"input,omitempty" json:"input,omitempty"`
	Output     string `yaml:"output,omitempty" json:"output,omitempty"`
	CacheRead  string `yaml:"cache_read,omitempty" json:"cache_read,omitempty"`
	CacheWrite string `yaml:"cache_write,omitempty" json:"cache_write,omitempty"`
	Cost       string `yaml:"cost,omitempty" json:"cost,omitempty"`
	Currency   string `yaml:"currency,omitempty" json:"currency,omitempty"` // 工具报的花费货币；写了 cost 才要
}

var (
	usageEventRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`)
	usagePathRE  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$`)
)

func (r Rules) usageProblems() []string {
	s := r.Usage
	if s == nil {
		return nil
	}
	var out []string
	if s.Event != "" && !usageEventRE.MatchString(s.Event) {
		out = append(out, "usage.event 不是合法的事件 type")
	}
	n := 0
	for _, kv := range []struct{ k, v string }{
		{"input", s.Input}, {"output", s.Output}, {"cache_read", s.CacheRead}, {"cache_write", s.CacheWrite}, {"cost", s.Cost},
	} {
		if kv.v == "" {
			continue
		}
		n++
		if !usagePathRE.MatchString(kv.v) {
			out = append(out, "usage."+kv.k+" 不是点分字段路径")
		}
	}
	if n == 0 {
		out = append(out, "usage 至少写一个 token 或花费字段")
	}
	if s.Cost != "" {
		if len(s.Currency) != 3 || strings.ToUpper(s.Currency) != s.Currency || strings.Trim(s.Currency, "ABCDEFGHIJKLMNOPQRSTUVWXYZ") != "" {
			out = append(out, "usage.currency 须是三位大写货币代码")
		}
	} else if s.Currency != "" {
		out = append(out, "usage.currency 只在写了 cost 时使用")
	}
	return out
}

// ExtractUsage 按档案声明从日志取用量（纯函数）：只认 JSON 行；缺字段保持 nil，花费 0 不当成报了。
func ExtractUsage(log string, spec UsageSpec) Usage {
	p := &Parser{}
	for _, line := range strings.Split(log, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		e := parseEvent(line)
		if e == nil {
			continue
		}
		if spec.Event != "" && e.str("type") != spec.Event {
			continue
		}
		u, ok := readUsage(e, spec)
		if ok {
			p.addUsage(u)
		}
	}
	return p.t.Usage
}

func readUsage(e event, spec UsageSpec) (Usage, bool) {
	var u Usage
	ok := false
	take := func(path string, dst **int64) {
		if path == "" {
			return
		}
		if n := pathNumber(e, path); n != nil {
			*dst, ok = n, true
		}
	}
	take(spec.Input, &u.Input)
	take(spec.Output, &u.Output)
	take(spec.CacheRead, &u.CacheRead)
	take(spec.CacheWrite, &u.CacheWrite)
	if spec.Cost != "" {
		if c := pathCost(e, spec.Cost); c != nil {
			u.Cost, u.Currency, ok = c, spec.Currency, true
		}
	}
	return u, ok
}

func lookup(v any, path string) any {
	cur := v
	for _, p := range strings.Split(path, ".") {
		var m map[string]any
		switch x := cur.(type) {
		case event:
			m = x
		case map[string]any:
			m = x
		default:
			return nil
		}
		cur = m[p]
	}
	return cur
}

func pathNumber(e event, path string) *int64 {
	f, ok := lookup(e, path).(float64)
	if !ok || f < 0 || f != math.Trunc(f) || f >= math.MaxInt64 {
		return nil
	}
	n := int64(f)
	return &n
}

func pathCost(e event, path string) *float64 {
	f, ok := lookup(e, path).(float64)
	if !ok || f <= 0 {
		return nil
	}
	return &f
}
