package web

import (
	"crypto/rand"
	"encoding/hex"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 一次性链接 2 分钟内有效、只能用一次；换来的会话只能读，服务重启即失效（再 atrium map 取一条）。
const (
	linkTTL    = 2 * time.Minute
	sessionTTL = 7 * 24 * time.Hour
	cookieName = "atrium_session"
)

// sessions 存一次性链接码与会话（都在内存里）。
type sessions struct {
	mu    sync.Mutex
	links map[string]time.Time // 码 → 过期时间
	live  map[string]time.Time // 会话 → 过期时间
	now   func() time.Time
}

func newSessions() *sessions {
	return &sessions{links: map[string]time.Time{}, live: map[string]time.Time{}, now: time.Now}
}

func randomToken() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		panic(err) // crypto/rand 失败说明系统坏了
	}
	return hex.EncodeToString(buf)
}

// newLink 发一个一次性链接码。
func (s *sessions) newLink() (string, time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.sweep(now)
	code := randomToken()
	s.links[code] = now.Add(linkTTL)
	return code, s.links[code]
}

// redeem 用掉链接码换会话；码不存在、已用、过期都返回 false。
func (s *sessions) redeem(code string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	exp, ok := s.links[code]
	delete(s.links, code) // 不论成败，码只能试一次
	if !ok || !valid(exp, now) {
		return "", false
	}
	sid := randomToken()
	s.live[sid] = now.Add(sessionTTL)
	return sid, true
}

func (s *sessions) check(sid string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	exp, ok := s.live[sid]
	return ok && valid(exp, s.now())
}

func (s *sessions) sweep(now time.Time) {
	for k, exp := range s.links {
		if !valid(exp, now) {
			delete(s.links, k)
		}
	}
	for k, exp := range s.live {
		if !valid(exp, now) {
			delete(s.live, k)
		}
	}
}

// valid 纯判定：没到过期时间。
func valid(exp, now time.Time) bool { return now.Before(exp) }

// localRequest 纯判定：请求来自本机回环地址，且 Host 头是本服务的回环地址（挡 DNS 重绑定）。
func localRequest(remoteAddr, host string, port int) bool {
	ip, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return false
	}
	if p := net.ParseIP(ip); p == nil || !p.IsLoopback() {
		return false
	}
	ps := strconv.Itoa(port)
	switch strings.ToLower(host) {
	case "127.0.0.1:" + ps, "localhost:" + ps, "[::1]:" + ps:
		return true
	}
	return false
}
