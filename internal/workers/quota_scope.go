package workers

import (
	"strings"

	"github.com/liu-zhengdong/atrium/internal/quota"
)

// quotaWindows 使用读取器已有的窗口 ID，隔开 Codex Spark 与普通预算，
// Claude 的模型专属窗口只作用于匹配的模型；不把专属限制扩大为全账号。
func quotaWindows(s Spec, ws []quota.Window) []quota.Window {
	model := strings.ToLower(s.Model)
	var out []quota.Window
	for _, w := range ws {
		switch {
		case s.Tool == "codex":
			if strings.HasPrefix(w.ID, "spark") != strings.Contains(model, "spark") {
				continue
			}
		case s.Tool == "claude" && w.ID == "sonnet":
			if !strings.Contains(model, "sonnet") {
				continue
			}
		case s.Tool == "claude" && strings.HasPrefix(w.ID, "scoped-"):
			// 未知的模型专属映射不猜；只接受读数中明确的模型名称匹配。
			if model == "" || !strings.EqualFold(w.Label, s.Model) {
				continue
			}
		}
		out = append(out, w)
	}
	return out
}

func (a Availability) spare(s Spec, r quota.Reading) quota.Spare {
	r.Windows = quotaWindows(s, r.Windows)
	sp := quota.SpareOf(quota.Line{Pace: quota.PaceOf(r, a.Now)}, a.Reserve)
	// 全局窗口与模型专属窗口分别取紧，继续使用 SpareOf 的保留份额规则。
	for _, w := range r.Windows {
		one := r
		one.Windows = []quota.Window{w}
		if tight := quota.SpareOf(quota.Line{Pace: quota.PaceOf(one, a.Now)}, a.Reserve); tight.Stop != "" {
			sp.Stop = tight.Stop
			break
		}
	}
	return sp
}

func (a Availability) sharesMark(source, target Spec, host string) bool {
	if !sharedQuota(source) || !sharedQuota(target) {
		return false
	}
	if source.Tool == "codex" && target.Tool == "codex" {
		return strings.Contains(strings.ToLower(source.Model), "spark") == strings.Contains(strings.ToLower(target.Model), "spark")
	}
	if source.Tool == "claude" && target.Tool == "claude" && source.Model != target.Model {
		// Claude 同时有全局和模型专属限制；有全局读数佐证才扩大模型范围。
		r := a.reading("claude", host)
		if r == nil {
			return false
		}
		for _, w := range r.Windows {
			if (w.ID == "session" || w.ID == "weekly") && w.Used >= 100-float64(a.Reserve) {
				return true
			}
		}
		return false
	}
	return true
}
