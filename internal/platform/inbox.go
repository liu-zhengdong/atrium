package platform

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

// 本文件是会话收件地址的共用投递协议：首行裸 token 鉴权，之后一行一条消息 JSON，每行回一条回执。
// 两套登记共用它——Pi（piinbox.go）与 DSH（dshinbox.go）：登记的文件名、目录与字段不同，线上的协议相同。

// inboxMessage 是投给会话的一条消息；一条一个 JSON，换行在 JSON 里转义。
type inboxMessage struct {
	Message   string `json:"message"`
	As        string `json:"as"`
	From      string `json:"from"`
	DeliverAs string `json:"deliverAs"`
}

// ErrInboxRejected：连上了会话，但会话回执拒收（如口令不对的 unauthorized）。和连不上分开：重试连接救不了它。
var ErrInboxRejected = errors.New("会话没收下")

// sendInboxMessages 投递若干条消息并逐条读回执；任一条没收下就报错（拒收的包着 ErrInboxRejected）。
// host 只用于错误文案。deliverAs=followUp：秘书会话忙时不打断，排在当前这轮之后。
func sendInboxMessages(host, endpoint, token string, messages []string, timeout time.Duration) error {
	conn, err := DialEndpoint(endpoint, timeout)
	if err != nil {
		return err
	}
	defer conn.Close()
	rw, ok := conn.(io.ReadWriter)
	if !ok {
		return fmt.Errorf("%s 收件地址 %s 不能读回执（只支持 Unix socket）", host, endpoint)
	}
	var w strings.Builder
	w.WriteString(token)
	w.WriteByte('\n')
	for _, m := range messages {
		raw, err := json.Marshal(inboxMessage{Message: m, As: "external", From: "atrium-secretary", DeliverAs: "followUp"})
		if err != nil {
			return err
		}
		w.Write(raw)
		w.WriteByte('\n')
	}
	if _, err := io.WriteString(rw, w.String()); err != nil {
		return err
	}
	rd := bufio.NewReader(rw)
	for i := range messages {
		line, err := rd.ReadString('\n')
		if err != nil {
			return fmt.Errorf("送出 %d 条后没收到回执：%w", i, err)
		}
		var reply struct {
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		}
		if err := json.Unmarshal([]byte(line), &reply); err != nil {
			return fmt.Errorf("回执认不出（%q）：%w", strings.TrimSpace(line), err)
		}
		if !reply.OK {
			return fmt.Errorf("%w：%s", ErrInboxRejected, reply.Error)
		}
	}
	return nil
}
