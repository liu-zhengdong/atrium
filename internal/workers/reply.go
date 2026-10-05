package workers

import (
	"bufio"
	"io"
	"os"
	"strings"
)

// maxReply 是记下的最后回复的上限（字符）。
const maxReply = 8000

// ReadReply 读整份日志取执行者最后一条回复；日志还没有时为空。gates 从这里读审阅结论。
// dsh 是逐行 JSON 事件：必须读完整份，收尾的 final 可能被中间的 text 事件挤出末尾。
func (a *Driver) ReadReply(path string) (string, error) {
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	defer f.Close()
	last := ""
	r := bufio.NewReaderSize(f, 64*1024)
	for {
		line, err := r.ReadString('\n')
		if text, ok := a.reply(line); ok {
			last = text
		}
		if err == io.EOF {
			return clip(last), nil
		}
		if err != nil {
			return "", err
		}
	}
}

// LastReply 取日志尾巴里执行者最后一条回复（纯函数）。
func (a *Driver) LastReply(tail string) string {
	lines := strings.Split(strings.TrimRight(tail, "\n"), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if text, ok := a.reply(lines[i]); ok {
			return clip(text)
		}
	}
	return ""
}

// reply 判一行事件是不是执行者的回复（纯函数）：dsh 的终稿在 type=final 一行。
func (a *Driver) reply(line string) (string, bool) {
	e := parseEvent(line)
	switch {
	case e == nil:
	case e.str("type") == "final":
		return e.str("text"), true
	}
	return "", false
}

func clip(s string) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > maxReply {
		return "…" + string(r[len(r)-maxReply:])
	}
	return s
}
