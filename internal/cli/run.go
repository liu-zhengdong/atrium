package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/config"
)

// Env 是命令运行的外部环境；测试里换成假的。
type Env struct {
	Stdout, Stderr io.Writer
	Getenv         func(string) string
}

// Ctx 是一次命令调用。
type Ctx struct {
	Context context.Context
	Args    []string // 位置参数
	JSON    bool
	Env     Env
	Table   *Table
	cmd     *Command
	values  map[string][]string
	bools   map[string]bool
	client  *api.Client
}

// UsageError 是命令行自己发现的参数错误（退出码 2）。
func UsageError(format string, a ...any) error { return api.Usage(format, a...) }

// Main 解析参数、跑命令、按约定打印；返回退出码。
func (t *Table) Main(ctx context.Context, args []string, env Env) int {
	jsonMode := contains(args, "--json")
	help := contains(args, "--help") || contains(args, "-h")
	if len(args) == 0 || (len(args) == 1 && args[0] == "--json") {
		if t.Default == "" {
			t.writeHelp(env.Stdout)
			return 0
		}
		args = append([]string{t.Default}, args...)
	}
	if help && !isCommandWord(args[0]) {
		t.writeHelp(env.Stdout)
		return 0
	}
	cmd, rest := t.Lookup(args)
	if cmd == nil {
		if t.hasGroup(args[0]) && (help || len(args) == 1) {
			t.writeGroupHelp(env.Stdout, args[0])
			return 0
		}
		return fail(env, jsonMode, api.Usage("没有这个命令：%s", strings.Join(leadingWords(args), " ")).
			WithNext(t.Name+" --help"))
	}
	if help {
		t.writeCommandHelp(env.Stdout, cmd)
		return 0
	}
	c := &Ctx{Context: ctx, Env: env, Table: t, cmd: cmd, JSON: jsonMode}
	if err := c.parse(rest); err != nil {
		return fail(env, jsonMode, err)
	}
	if !cmd.WorkerOK && env.Getenv("ATRIUM_WORKER") == "1" {
		return fail(env, jsonMode, &api.Error{Code: "forbidden",
			Message: "执行者（ATRIUM_WORKER=1）不能操作用户的 Atrium 服务"})
	}
	if err := cmd.Run(c); err != nil {
		return fail(env, jsonMode, err)
	}
	return 0
}

func isCommandWord(s string) bool { return !strings.HasPrefix(s, "-") }

func leadingWords(args []string) []string {
	var out []string
	for _, a := range args {
		if strings.HasPrefix(a, "-") || len(out) == 3 {
			break
		}
		out = append(out, a)
	}
	return out
}

func contains(args []string, s string) bool {
	for _, a := range args {
		if a == "--" {
			return false
		}
		if a == s {
			return true
		}
	}
	return false
}

func (c *Ctx) parse(args []string) error {
	c.values, c.bools = map[string][]string{}, map[string]bool{}
	known := map[string]Flag{}
	for _, f := range c.cmd.Flags {
		known[f.Name] = f
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			c.Args = append(c.Args, args[i+1:]...)
			break
		}
		if !strings.HasPrefix(a, "--") || a == "--json" {
			if a != "--json" {
				c.Args = append(c.Args, a)
			}
			continue
		}
		name, value, hasValue := strings.Cut(a[2:], "=")
		f, ok := known[name]
		if !ok {
			return api.Usage("--%s: 不认识这个参数", name).WithNext(c.Table.Name + " " + c.cmd.Path + " --help")
		}
		if f.Bool {
			if hasValue {
				return api.Usage("--%s: 是开关，不带值", name)
			}
			c.bools[name] = true
			continue
		}
		if !hasValue {
			// 下一个是 --参数时当作缺值；真要以 -- 开头的值写成 --名字=值。
			if i+1 >= len(args) || strings.HasPrefix(args[i+1], "--") {
				return api.Usage("--%s: 缺值", name)
			}
			i++
			value = args[i]
		}
		if !f.Multi && len(c.values[name]) > 0 {
			return api.Usage("--%s: 只能给一次", name)
		}
		c.values[name] = append(c.values[name], value)
	}
	return nil
}

// Has 判断参数是否给了（值可以是空串，用于「清空某字段」）。
func (c *Ctx) Has(name string) bool {
	_, ok := c.values[name]
	return ok || c.bools[name]
}

func (c *Ctx) Str(name string) string {
	if v := c.values[name]; len(v) > 0 {
		return v[0]
	}
	return ""
}

// Opt 返回参数值的指针：没给是 nil（PATCH 用：只改给了的字段）。
func (c *Ctx) Opt(name string) *string {
	if v := c.values[name]; len(v) > 0 {
		return &v[0]
	}
	return nil
}

func (c *Ctx) Bool(name string) bool { return c.bools[name] }

// List 合并重复给的值，并按逗号拆开，去掉空项。
func (c *Ctx) List(name string) []string {
	var out []string
	for _, v := range c.values[name] {
		for _, p := range strings.Split(v, ",") {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
	}
	return out
}

// Values 是可重复参数的原值（不按逗号拆），给值里本身带逗号的参数用（如 --set checks=[a,b]）。
func (c *Ctx) Values(name string) []string { return c.values[name] }

func (c *Ctx) Int(name string, def int) (int, error) {
	v := c.Str(name)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, api.Usage("--%s: 应为整数，收到 %q", name, v)
	}
	return n, nil
}

// Arg 取第 i 个位置参数；缺了报用法错误。
func (c *Ctx) Arg(i int, name string) (string, error) {
	if i >= len(c.Args) || strings.TrimSpace(c.Args[i]) == "" {
		return "", api.Usage("缺少 %s", name).WithNext(c.Table.Name + " " + c.cmd.Path + " --help")
	}
	return c.Args[i], nil
}

// MaxArgs 拒绝多余的位置参数（常见于忘了给文字加引号）。
func (c *Ctx) MaxArgs(n int) error {
	if len(c.Args) > n {
		return api.Usage("多了参数：%s（含空格的文字请加引号）", strings.Join(c.Args[n:], " "))
	}
	return nil
}

// Paths 是当前数据目录。
func (c *Ctx) Paths() (config.Paths, error) { return config.Resolve(c.Env.Getenv) }

// Call 经服务 HTTP 完成一次调用，结果解到 out。
func (c *Ctx) Call(method, path string, body, out any) error {
	if c.client == nil {
		p, err := c.Paths()
		if err != nil {
			return err
		}
		info, err := config.ReadService(p)
		if errors.Is(err, config.ErrNotRegistered) {
			return (&api.Error{Code: "not_running", Message: "服务没在运行（数据目录 " + p.Data + "）"}).WithNext(c.Table.Name + " start")
		}
		if err != nil {
			return err
		}
		// 负责人进程带本次唤醒签发的令牌，服务端按它判权限；其余用用户令牌。
		token := c.Env.Getenv("ATRIUM_LEADER_TOKEN")
		if token == "" {
			if token, err = config.ReadToken(p); err != nil {
				return err
			}
		}
		c.client = &api.Client{Base: fmt.Sprintf("http://127.0.0.1:%d", info.Port), Token: token}
	}
	return c.client.Do(c.Context, method, path, body, out)
}

// ResetClient 丢掉缓存的连接信息（服务重启后端口或令牌可能变了）。
func (c *Ctx) ResetClient() { c.client = nil }

// Done 打印成功回执：人读模式先 text 再「下一步：next」；--json 输出信封。
func (c *Ctx) Done(result any, text, next string) error {
	if c.JSON {
		return json.NewEncoder(c.Env.Stdout).Encode(map[string]any{"ok": true, "result": result, "next": next})
	}
	if text != "" {
		fmt.Fprintln(c.Env.Stdout, strings.TrimRight(text, "\n"))
	}
	if next != "" {
		fmt.Fprintf(c.Env.Stdout, "下一步：%s\n", next)
	}
	return nil
}

func fail(env Env, jsonMode bool, err error) int {
	var ae *api.Error
	if !errors.As(err, &ae) {
		ae = &api.Error{Code: "error", Message: err.Error()}
	}
	if jsonMode {
		json.NewEncoder(env.Stdout).Encode(map[string]any{"ok": false, "error": ae})
	} else {
		fmt.Fprintf(env.Stderr, "错误：%s\n", ae.Message)
		if ae.Next != "" {
			fmt.Fprintf(env.Stderr, "修正：%s\n", ae.Next)
		}
	}
	if ae.Code == "usage" {
		return 2
	}
	return 1
}
