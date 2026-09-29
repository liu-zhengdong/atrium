package events

import (
	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/cli"
)

// 结果会不会推给调用者：会推的人不该在前台等（task wait、task log --follow、events wait），
// 派活、合入后直接回来，结果以事件送到。秘书要随时待命，负责人一次唤醒只有 20 分钟。

// PushedNote 是会推送时回执里代替「下一步」的一句。
const PushedNote = "不用等：结果会作为事件送来"

// Pushed 判定调用者的结果会不会推送：负责人由唤醒送达；秘书在听时由桥接注入会话。纯函数。
func Pushed(a api.Actor, secretaryListening bool) bool {
	return a.Kind == "leader" || (a.ID == Secretary && secretaryListening)
}

// AsyncNext 给异步回执定结尾：会推送时在 text 后加 PushedNote、不给等待命令；否则原样返回 wait。
func AsyncNext(c *cli.Ctx, text, wait string) (string, string, error) {
	var out struct {
		Pushed bool `json:"pushed"`
	}
	if err := c.Call("GET", "/api/events/pushed", nil, &out); err != nil {
		return "", "", err
	}
	if !out.Pushed {
		return text, wait, nil
	}
	if text != "" {
		text += "\n"
	}
	return text + PushedNote, "", nil
}
