// Package api 是服务端路由与命令行客户端共用的 HTTP 约定：
// 成功 {"ok":true,"result":…}；失败 {"ok":false,"error":{"code","message","next"?}}。
// 认证在路由匹配之后的统一入口做，默认拒绝；只有用 Public 注册的路由免认证。
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
)

// Actor 是请求的发起身份：用户令牌得到 u1（带 AsHeader: secretary 时为 secretary）；负责人令牌得到 Kind "leader"，ID aN。
// 权限按 Kind 判，署名（任务分派人、决定人、备注作者）用 ID。
type Actor struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
}

// AsHeader 是调用方声明的署名（命令行取自环境变量 ATRIUM_AS，秘书会话的项目设置里写着 secretary）。
const AsHeader = "X-Atrium-As"

// Sign 纯函数：按声明的署名定最终身份。只改用户令牌的署名、只认 secretary，权限不变（Kind 仍是 user）；
// 其他身份忽略它（负责人会话也可能读到秘书目录的项目设置）。
func Sign(a Actor, as string) (Actor, error) {
	if as == "" || a.Kind != "user" {
		return a, nil
	}
	if as != "secretary" {
		return a, Usage("ATRIUM_AS: 只能是 secretary，收到 %q", as)
	}
	return Actor{ID: "secretary", Kind: "user"}, nil
}

// Error 是对外的错误：Code 给程序判断，Message 给人看，Next 是明确可执行的修正命令（没有就空）。
type Error struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Next    string `json:"next,omitempty"`
}

func (e *Error) Error() string { return e.Message }

func Usage(format string, a ...any) *Error {
	return &Error{Status: 400, Code: "usage", Message: fmt.Sprintf(format, a...)}
}
func NotFound(format string, a ...any) *Error {
	return &Error{Status: 404, Code: "not_found", Message: fmt.Sprintf(format, a...)}
}
func Conflict(format string, a ...any) *Error {
	return &Error{Status: 409, Code: "conflict", Message: fmt.Sprintf(format, a...)}
}

// Limit 是「满了」：必须告诉调用方怎么腾地方（next）。
func Limit(next, format string, a ...any) *Error {
	return &Error{Status: 409, Code: "limit", Message: fmt.Sprintf(format, a...), Next: next}
}
func Forbidden(format string, a ...any) *Error {
	return &Error{Status: 403, Code: "forbidden", Message: fmt.Sprintf(format, a...)}
}

// Unavailable：服务正在停下或重启，调用方等新服务起来后重发。
func Unavailable(format string, a ...any) *Error {
	return &Error{Status: 503, Code: "restarting", Message: fmt.Sprintf(format, a...)}
}

// WithNext 给错误附上修正命令。
func (e *Error) WithNext(next string) *Error { e.Next = next; return e }

// Req 是一次已认证的请求。
type Req struct {
	*http.Request
	Actor Actor
}

// Decode 读 JSON 请求体（上限 1MB），拒绝未知字段。
func (r *Req) Decode(v any) error { return r.DecodeMax(v, 1<<20) }

// DecodeMax 同 Decode，请求体上限 max 字节（只给确实要传大文件的接口放宽，如资料上传）。
// 超了上限报「请求体超过 N MB」，不当成 JSON 不合法。
func (r *Req) DecodeMax(v any, max int64) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, max))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return Usage("请求体超过这个接口的上限 %.1f MB：拆小或分几次", float64(max)/(1<<20))
		}
		return Usage("请求体不合法：%v", err)
	}
	return nil
}

// Peek 读出整个 JSON 请求体解到 v（不拒未知字段）再放回，处理函数照常 Decode：给权限判定（Guard）看请求体用。
// 按 max 读全：只读一截会把合法的大请求（如资料上传）截断成不合法的 JSON。请求体为空时 v 不变。
func (r *Req) Peek(v any, max int64) error {
	if r.Body == nil {
		return nil
	}
	raw, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, max))
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		return Usage("请求体超过上限 %.1f MB：拆小或分几次", float64(max)/(1<<20))
	}
	if err != nil {
		return err
	}
	r.Body = io.NopCloser(bytes.NewReader(raw))
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return Usage("请求体不合法：%v", err)
	}
	return nil
}

var refPattern = regexp.MustCompile(`^[a-z][1-9][0-9]*$`)

// Ref 取路径参数里的短号并核对前缀（如 Ref("id","t") 只接 t12）。
func (r *Req) Ref(name, prefix string) (string, error) {
	v := r.PathValue(name)
	if !refPattern.MatchString(v) || !strings.HasPrefix(v, prefix) {
		return "", Usage("%s 应为 %sN 形式的短号，收到 %q", name, prefix, v)
	}
	return v, nil
}

// IsRef 判断字符串是不是某前缀的短号。
func IsRef(v, prefix string) bool { return refPattern.MatchString(v) && strings.HasPrefix(v, prefix) }

type Handler func(r *Req) (any, error)

// Authenticator 由令牌认出身份；认不出返回 false。
type Authenticator func(token string) (Actor, bool)

// Guard 在认证之后、处理函数之前对某类身份做统一的权限判定（路由已匹配，q.Pattern 可用）；
// 返回错误即拒绝。可以读请求体，但读完要放回（q.Body）。
type Guard func(q *Req) error

type Router struct {
	mux      *http.ServeMux
	patterns []string // 需认证的路由（Handle 注册的），权限表的测试核对用
	auths    []Authenticator
	guards   map[string]Guard
	Log      *slog.Logger
}

func NewRouter(log *slog.Logger) *Router {
	r := &Router{mux: http.NewServeMux(), Log: log}
	r.mux.HandleFunc("/", func(w http.ResponseWriter, req *http.Request) {
		write(w, NotFound("没有这个接口：%s %s", req.Method, req.URL.Path), nil, log)
	})
	return r
}

// AddAuth 追加一种令牌认证（用户令牌、第二波的负责人令牌、机器令牌）。
func (r *Router) AddAuth(a Authenticator) { r.auths = append(r.auths, a) }

// AddGuard 给某类身份（Actor.Kind，如 "leader"）装统一的权限判定：这类身份的每个请求都先过它。
func (r *Router) AddGuard(kind string, g Guard) {
	if r.guards == nil {
		r.guards = map[string]Guard{}
	}
	r.guards[kind] = g
}

// Handle 注册需认证的路由，pattern 用 Go 1.22 写法，如 "POST /api/tasks/{id}/notes"。
func (r *Router) Handle(pattern string, h Handler) { r.handle(pattern, h, true) }

// Public 注册免认证的路由（只给 /health 这类）。
func (r *Router) Public(pattern string, h Handler) { r.handle(pattern, h, false) }

// Raw 注册不走 JSON 信封与令牌认证的原始处理函数：只给网页（静态文件、只读接口、SSE）用，
// 处理函数自己把关（web 只放行本机 Host 头）。
func (r *Router) Raw(pattern string, h http.HandlerFunc) { r.mux.HandleFunc(pattern, h) }

// WriteJSON 按信封写一次结果（Raw 处理函数里返回 JSON 用）。
func WriteJSON(w http.ResponseWriter, err error, result any, log *slog.Logger) {
	write(w, err, result, log)
}

// Patterns 列出 Handle 注册的全部路由模式（按注册顺序）。
func (r *Router) Patterns() []string { return append([]string{}, r.patterns...) }

func (r *Router) handle(pattern string, h Handler, auth bool) {
	if auth {
		r.patterns = append(r.patterns, pattern)
	}
	r.mux.HandleFunc(pattern, func(w http.ResponseWriter, hr *http.Request) {
		req := &Req{Request: hr}
		if auth {
			actor, ok := r.authenticate(hr)
			if !ok {
				write(w, &Error{Status: 401, Code: "unauthorized", Message: "令牌无效或缺失"}, nil, r.Log)
				return
			}
			var err error
			if req.Actor, err = Sign(actor, hr.Header.Get(AsHeader)); err != nil {
				write(w, err, nil, r.Log)
				return
			}
			if g := r.guards[actor.Kind]; g != nil {
				if err := g(req); err != nil {
					write(w, err, nil, r.Log)
					return
				}
			}
		}
		result, err := h(req)
		write(w, err, result, r.Log)
	})
}

func (r *Router) authenticate(hr *http.Request) (Actor, bool) {
	token, ok := strings.CutPrefix(hr.Header.Get("Authorization"), "Bearer ")
	if !ok || token == "" {
		return Actor{}, false
	}
	for _, a := range r.auths {
		if actor, ok := a(token); ok {
			return actor, true
		}
	}
	return Actor{}, false
}

func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) { r.mux.ServeHTTP(w, req) }

type envelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *Error          `json:"error,omitempty"`
}

func write(w http.ResponseWriter, err error, result any, log *slog.Logger) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if err != nil {
		var ae *Error
		if !errors.As(err, &ae) {
			if errors.Is(err, context.Canceled) {
				ae = Unavailable("服务正在重启或停下，请稍后重发")
			} else {
				if log != nil {
					log.Error("内部错误", "err", err)
				}
				ae = &Error{Status: 500, Code: "internal", Message: err.Error()}
			}
		}
		w.WriteHeader(ae.Status)
		json.NewEncoder(w).Encode(envelope{Error: ae})
		return
	}
	raw, mErr := json.Marshal(result)
	if mErr != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(envelope{Error: &Error{Code: "internal", Message: mErr.Error()}})
		return
	}
	json.NewEncoder(w).Encode(envelope{OK: true, Result: raw})
}
