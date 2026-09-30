package workers

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// 执行者会话的工具集由 Atrium 给出，不继承用户个人配置：
//   - claude：--strict-mcp-config 且不给 --mcp-config，一个 MCP 都不带（用户级 MCP、插件带的 MCP、claude.ai 连接器）。
//     执行者要看网页、截图，自己起独立资料目录的无头浏览器，不连用户或别的执行者的浏览器。
//   - codex：--ignore-user-config 不读用户 config.toml，只把本机的 computer use 那几张表原样带上（computerUseTables）。
//     账号自带的 codex_apps（ChatGPT 应用连接器）不在 config.toml 里，照旧在。
//
// computer use 是 Codex 桌面版装的「操作本机应用」工具：macOS 上是 mcp_servers.computer-use，
// Windows 上是 computer-use 插件（技能说明）加它要的 node_repl（js 工具里的 sky 接口）。逐应用授权是 MCP elicitation，
// 非交互会话里只有 --dangerously-bypass-approvals-and-sandbox 能放行；执行者本来就不开沙箱，这不改变它能做什么。
// 用不用由部门要点管（不操作用户的电脑，用户指定的实验除外）。
// Browser、Chrome 插件（控制浏览器，要 Chrome 扩展或桌面版内置浏览器）不是 computer use，不带。

// computerUseTables 是 codex 执行者从用户 config.toml 带上的表（连同子表，如 mcp_servers.node_repl.env）。
// 前两项是「装了 computer use」的标志：都没有（或都 enabled = false）就一张也不带。
var computerUseTables = []string{
	`mcp_servers.computer-use`,
	`plugins."computer-use@openai-bundled"`,
	`mcp_servers.node_repl`,
}

// LocalTools 在拉起那台机器上补进只有本机知道的工具：codex 带上本机装的 computer use。
// 本机拉起和远程代理拉起前各调一次（Build 本身是纯函数）。没装 codex 配置就什么都不带。
func LocalTools(tool string, req Request) (Request, error) {
	if tool != "codex" || req.CLI != nil {
		return req, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return req, err
	}
	b, err := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if errors.Is(err, fs.ErrNotExist) {
		return req, nil
	}
	if err != nil {
		return req, err
	}
	req.ComputerUse, err = ComputerUseOverrides(string(b))
	if err != nil {
		return req, fmt.Errorf("读 ~/.codex/config.toml 里的 computer use：%w", err)
	}
	return req, nil
}

// ComputerUseOverrides 从 config.toml 正文取出 computerUseTables，按顶层键各写成一个 codex 的 -c 覆盖
// （`mcp_servers={node_repl={command='…',env={…}}}`，值是原文）。codex 的 -c 按点拆路径、不认带引号的键
// （`plugins."x@y".enabled=true` 会被静默忽略），所以整张写成内联表。
// 纯函数。只认单行的「键 = 值」；这些表里出现跨行的值就报错，不猜。
func ComputerUseOverrides(config string) ([]string, error) {
	root := &tomlNode{}
	enabled := map[string]bool{}
	table, take := "", false
	for i, line := range strings.Split(config, "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if line == "" || line[0] == '#' {
			continue
		}
		if line[0] == '[' {
			table, take = tableName(line), false
			for _, t := range computerUseTables {
				if table == t || strings.HasPrefix(table, t+".") {
					take = true
					enabled[t] = enabled[t] || table == t
				}
			}
			continue
		}
		if !take {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("第 %d 行 [%s] 下不是「键 = 值」", i+1, table)
		}
		k = tableName("[" + k + "]")
		v, err := tomlValue(v)
		if err != nil {
			return nil, fmt.Errorf("第 %d 行 %s.%s：%w", i+1, table, k, err)
		}
		if k == "enabled" && v == "false" && slices.Contains(computerUseTables, table) {
			enabled[table] = false
		}
		if err := root.set(append(splitKey(table), splitKey(k)...), v); err != nil {
			return nil, fmt.Errorf("第 %d 行 %s.%s：%w", i+1, table, k, err)
		}
	}
	if !enabled[computerUseTables[0]] && !enabled[computerUseTables[1]] {
		return nil, nil
	}
	out := make([]string, 0, len(root.keys))
	for _, k := range root.keys {
		out = append(out, k+"="+root.kids[k].inline())
	}
	return out, nil
}

// tomlNode 是按出现顺序记下的键树：叶子有 val，表有 kids。
type tomlNode struct {
	val  string
	keys []string
	kids map[string]*tomlNode
}

func (n *tomlNode) set(path []string, v string) error {
	for _, k := range path {
		if n.val != "" {
			return errors.New("同一个键既是值又是表")
		}
		if n.kids == nil {
			n.kids = map[string]*tomlNode{}
		}
		if n.kids[k] == nil {
			n.kids[k] = &tomlNode{}
			n.keys = append(n.keys, k)
		}
		n = n.kids[k]
	}
	if n.val != "" || n.kids != nil {
		return errors.New("键重复")
	}
	n.val = v
	return nil
}

func (n *tomlNode) inline() string {
	if n.kids == nil {
		return n.val
	}
	parts := make([]string, len(n.keys))
	for i, k := range n.keys {
		parts[i] = k + "=" + n.kids[k].inline()
	}
	return "{" + strings.Join(parts, ",") + "}"
}

// tableName 把 `[ a . "b c" ]` 规整成 `a."b c"`（去掉引号外的空白，引号里原样）；`[[数组表]]` 返回空，不会被选中。
func tableName(line string) string {
	if strings.HasPrefix(line, "[[") {
		return ""
	}
	var b strings.Builder
	quote := rune(0)
	for _, r := range line[1:] {
		switch {
		case quote != 0:
			b.WriteRune(r)
			if r == quote {
				quote = 0
			}
		case r == '"' || r == '\'':
			quote = r
			b.WriteRune(r)
		case r == ']':
			return b.String()
		case r != ' ' && r != '\t':
			b.WriteRune(r)
		}
	}
	return b.String()
}

// splitKey 按引号外的点拆开规整过的键（各段保留原来的引号）。
func splitKey(k string) []string {
	var out []string
	quote, start := rune(0), 0
	for i, r := range k {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			}
		case r == '"' || r == '\'':
			quote = r
		case r == '.':
			out = append(out, k[start:i])
			start = i + 1
		}
	}
	return append(out, k[start:])
}

// tomlValue 去掉值两边的空白和行尾注释（引号外的 #），并要求括号在这一行里配平。
func tomlValue(v string) (string, error) {
	v = strings.TrimSpace(v)
	if strings.HasPrefix(v, `"""`) || strings.HasPrefix(v, `'''`) {
		return "", errors.New("跨行字符串")
	}
	depth, quote, esc := 0, rune(0), false
scan:
	for i, r := range v {
		switch {
		case esc:
			esc = false
		case quote != 0:
			if r == '\\' && quote == '"' {
				esc = true
			} else if r == quote {
				quote = 0
			}
		case r == '"' || r == '\'':
			quote = r
		case r == '[' || r == '{':
			depth++
		case r == ']' || r == '}':
			depth--
		case r == '#':
			v = strings.TrimSpace(v[:i])
			break scan
		}
	}
	if v == "" || depth != 0 || quote != 0 {
		return "", errors.New("值跨行或引号、括号没配平")
	}
	return v, nil
}
