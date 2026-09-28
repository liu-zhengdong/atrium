// Package service 是服务进程的生命周期：单实例登记、用户令牌、启动、停止、平滑重启、一键停机。
// 服务只听 127.0.0.1；除 /health 外全部路由要令牌。
package service

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Version 由发版时 -ldflags "-X .../service.Version=…" 写入。
var Version = "v2-dev"

// replaceEnv：平滑重启时新进程据此知道要接手哪个旧进程（旧进程放开端口前它等着）。
const replaceEnv = "ATRIUM_REPLACE_PID"

type server struct {
	env     *app.Env
	started int64
	stop    chan string // "stop" | "restart"
	mu      sync.Mutex
	token   string // auth rotate 会换掉它
}

// Serve 是服务进程的主函数（atrium serve）：直到收到停止、重启或信号才返回。
func Serve(mods []app.Module, getenv func(string) string) error {
	paths, err := config.Resolve(getenv)
	if err != nil {
		return err
	}
	port, err := config.Port(getenv)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(paths.Data, 0o700); err != nil {
		return err
	}
	replacing, _ := strconv.Atoi(getenv(replaceEnv))
	if info, err := config.ReadService(paths); err == nil && info.PID != replacing && info.PID != os.Getpid() && platform.Alive(info.PID) {
		return fmt.Errorf("已有服务在跑（pid %d，端口 %d）；同一数据目录只能有一个服务", info.PID, info.Port)
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	db, err := store.Open(paths.DB())
	if err != nil {
		return err
	}
	defer db.Close()
	token, err := ensureToken(paths)
	if err != nil {
		return err
	}
	s := &server{
		env:     &app.Env{DB: db, Paths: paths, Port: port, Log: log, Pause: &pause.Store{DB: db}},
		started: store.Now(),
		stop:    make(chan string, 1),
		token:   token,
	}
	router := api.NewRouter(log)
	router.AddAuth(func(t string) (api.Actor, bool) {
		s.mu.Lock()
		current := s.token
		s.mu.Unlock()
		if subtle.ConstantTimeCompare([]byte(t), []byte(current)) == 1 {
			return api.Actor{ID: "u1", Kind: "user"}, true
		}
		return api.Actor{}, false
	})
	s.routes(router)
	for _, m := range mods {
		if m.Routes != nil {
			m.Routes(router, s.env)
		}
	}

	wait := time.Duration(0)
	if replacing != 0 {
		wait = 15 * time.Second // 等旧进程放开端口
	}
	ln, err := listen(fmt.Sprintf("127.0.0.1:%d", port), wait)
	if err != nil {
		return err
	}
	baseCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	srv := &http.Server{Handler: router, ReadHeaderTimeout: 10 * time.Second,
		BaseContext: func(net.Listener) context.Context { return baseCtx }}
	if err := config.WriteService(paths, config.ServiceInfo{PID: os.Getpid(), Port: port, StartedAt: s.started, Version: Version}); err != nil {
		ln.Close()
		return err
	}
	log.Info("服务已启动", "pid", os.Getpid(), "port", port, "data", paths.Data, "version", Version)

	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ln) }()
	var wg sync.WaitGroup
	for _, m := range mods {
		if m.Run == nil {
			continue
		}
		wg.Add(1)
		go func(m app.Module) {
			defer wg.Done()
			if err := m.Run(baseCtx, s.env); err != nil && !errors.Is(err, context.Canceled) {
				log.Error("后台循环出错，服务停下", "module", m.Name, "err", err)
				s.request("stop")
			}
		}(m)
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	var reason string
	select {
	case reason = <-s.stop:
	case got := <-sig:
		reason = "signal " + got.String()
	case err := <-serveErr:
		return err
	}
	log.Info("服务停下", "reason", reason)
	cancel() // 先打断长轮询与后台循环，再排空在途请求
	shutdownCtx, done := context.WithTimeout(context.Background(), 15*time.Second)
	defer done()
	err = srv.Shutdown(shutdownCtx)
	wg.Wait()
	// 重启时登记文件交给新进程覆盖；正常停下才删，且只删自己的。
	if reason != "restart" {
		if info, rerr := config.ReadService(paths); rerr == nil && info.PID == os.Getpid() {
			os.Remove(paths.Service())
		}
	}
	return err
}

func (s *server) request(reason string) {
	select {
	case s.stop <- reason:
	default:
	}
}

func listen(addr string, wait time.Duration) (net.Listener, error) {
	deadline := time.Now().Add(wait)
	for {
		ln, err := net.Listen("tcp", addr)
		if err == nil || time.Now().After(deadline) {
			if err != nil {
				return nil, fmt.Errorf("监听 %s 失败：%w", addr, err)
			}
			return ln, nil
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// ensureToken 读用户令牌；没有就生成一个。
func ensureToken(p config.Paths) (string, error) {
	if t, err := config.ReadToken(p); err == nil && t != "" {
		return t, nil
	}
	return writeToken(p)
}

// writeToken 生成新令牌，先写临时文件（0600）再改名替换。
func writeToken(p config.Paths) (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	token := hex.EncodeToString(buf)
	tmp := p.Token() + ".tmp"
	if err := os.WriteFile(tmp, []byte(token+"\n"), 0o600); err != nil {
		return "", fmt.Errorf("写用户令牌失败：%w", err)
	}
	return token, os.Rename(tmp, p.Token())
}

// rotate 换用户令牌：写文件后立即生效，旧令牌作废。
func (s *server) rotate() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	token, err := writeToken(s.env.Paths)
	if err != nil {
		return err
	}
	s.token = token
	return nil
}

// spawnServe 拉起一个新的服务进程（start 与 restart 共用）。环境走服务白名单；
// replacing 非 0 时新进程会等这个旧进程放开端口。
func spawnServe(p config.Paths, base map[string]string, replacing int) (pid int, dropped []string, err error) {
	exe, err := os.Executable()
	if err != nil {
		return 0, nil, err
	}
	env, dropped := platform.ServiceEnv(runtime.GOOS, base)
	delete(env, replaceEnv)
	if replacing != 0 {
		env[replaceEnv] = strconv.Itoa(replacing)
	}
	env["ATRIUM_DATA"] = p.Data
	if err := os.MkdirAll(p.Data, 0o700); err != nil {
		return 0, nil, err
	}
	logf, err := os.OpenFile(p.Log(), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return 0, nil, err
	}
	defer logf.Close()
	cmd, err := platform.Start(platform.Spec{Path: exe, Args: []string{"serve"}, Env: env,
		Stdout: logf, Stderr: logf, Detached: true})
	if err != nil {
		return 0, nil, err
	}
	pid = cmd.Process.Pid
	return pid, dropped, cmd.Process.Release()
}
