package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
)

// Client 是命令行到服务的调用。没有超时：长轮询（task wait、events wait）的时长由服务端参数决定。
type Client struct {
	Base  string // http://127.0.0.1:4320
	Token string
	As    string // 声明的署名（AsHeader），空则不带
	HTTP  *http.Client
}

// Do 发请求并把 result 解到 out（out 可为 nil）。服务返回 ok:false 时得到 *Error。
func (c *Client) Do(ctx context.Context, method, path string, body, out any) error {
	var rd *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(raw)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Base+path, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if c.As != "" {
		req.Header.Set(AsHeader, c.As)
	}
	hc := c.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		// 按拨号失败判定，不比对 ECONNREFUSED：Windows 上拒绝连接是 WSAECONNREFUSED（10061），syscall 里没有这个常量。
		var op *net.OpError
		if errors.As(err, &op) && op.Op == "dial" {
			return (&Error{Code: "not_running", Message: "连不上服务（" + c.Base + "）"}).WithNext("atrium start")
		}
		return err
	}
	defer resp.Body.Close()
	var env envelope
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		return fmt.Errorf("服务回了不合法的响应（HTTP %d）：%w", resp.StatusCode, err)
	}
	if !env.OK {
		if env.Error == nil {
			return fmt.Errorf("服务回了 ok:false 但没有 error（HTTP %d）", resp.StatusCode)
		}
		env.Error.Status = resp.StatusCode
		return env.Error
	}
	if out != nil && len(env.Result) > 0 {
		return json.Unmarshal(env.Result, out)
	}
	return nil
}
