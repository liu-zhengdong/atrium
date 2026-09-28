package quota

import (
	"crypto/sha256"
	"encoding/hex"
	"path"
	"strings"
)

// Source 是一份凭据的位置：文件或 macOS 钥匙串项。路径判定只产出它，不读。
type Source struct {
	File    string
	Service string // 钥匙串服务名（File 为空时）
	Account string // 钥匙串账号
}

func (s Source) String() string {
	if s.File != "" {
		return s.File
	}
	return "钥匙串「" + s.Service + "」"
}

// joinFor 按目标平台拼路径（纯函数，三平台都能在任一台上测）。
func joinFor(goos string, parts ...string) string {
	if goos != "windows" {
		return path.Join(parts...)
	}
	var out []string
	for i, p := range parts {
		p = strings.ReplaceAll(p, "/", `\`)
		if i > 0 {
			p = strings.Trim(p, `\`)
		} else {
			p = strings.TrimRight(p, `\`)
		}
		if p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, `\`)
}

// expandHome 把 ~ 与 ~/x 展开到主目录。
func expandHome(goos, v, home string) string {
	if v == "~" {
		return home
	}
	if strings.HasPrefix(v, "~/") || strings.HasPrefix(v, `~\`) {
		return joinFor(goos, home, v[2:])
	}
	return v
}

func envOf(env map[string]string, k string) string { return strings.TrimSpace(env[k]) }

const claudeKeychain = "Claude Code-credentials"

// scopedClaudeService：设了 CLAUDE_CONFIG_DIR 时 Claude Code 用的钥匙串服务名（原名 + 目录 sha256 前 8 位）。
func scopedClaudeService(dir string) string {
	sum := sha256.Sum256([]byte(strings.ReplaceAll(dir, `\`, "/")))
	return claudeKeychain + "-" + hex.EncodeToString(sum[:])[:8]
}

// ClaudeSources：三平台上 Claude Code 登录的位置。
//
//	macOS   钥匙串「Claude Code-credentials」在前，再退回 ~/.claude/.credentials.json
//	Linux   ~/.claude/.credentials.json、$XDG_CONFIG_HOME/claude（缺省 ~/.config/claude）
//	Windows %USERPROFILE%\.claude\.credentials.json
//
// 设了 CLAUDE_CONFIG_DIR 就只认它（macOS 另查按目录派生的钥匙串项）。
func ClaudeSources(goos, home string, env map[string]string) []Source {
	cfg := envOf(env, "CLAUDE_CONFIG_DIR")
	var dirs []string
	switch {
	case cfg != "":
		dirs = []string{expandHome(goos, cfg, home)}
	case goos == "linux":
		xdg := envOf(env, "XDG_CONFIG_HOME")
		if xdg == "" {
			xdg = joinFor(goos, home, ".config")
		}
		dirs = []string{joinFor(goos, home, ".claude"), joinFor(goos, xdg, "claude")}
	default:
		dirs = []string{joinFor(goos, home, ".claude")}
	}
	var files []Source
	for _, d := range dirs {
		files = append(files, Source{File: joinFor(goos, d, ".credentials.json")})
	}
	if goos != "darwin" {
		return files
	}
	services := []string{claudeKeychain}
	if cfg != "" {
		services = []string{scopedClaudeService(cfg), claudeKeychain}
	}
	accounts := []string{""}
	if u := envOf(env, "USER"); u != "" {
		accounts = []string{u, ""}
	} else if u := envOf(env, "LOGNAME"); u != "" {
		accounts = []string{u, ""}
	}
	var out []Source
	for _, s := range services {
		for _, a := range accounts {
			out = append(out, Source{Service: s, Account: a})
		}
	}
	return append(out, files...)
}

// ClaudeAccountFile 是记登录账号（oauthAccount）的 .claude.json，只用来算账号指纹。
func ClaudeAccountFile(goos, home string, env map[string]string) string {
	if cfg := envOf(env, "CLAUDE_CONFIG_DIR"); cfg != "" {
		return joinFor(goos, expandHome(goos, cfg, home), ".claude.json")
	}
	return joinFor(goos, home, ".claude.json")
}

// CodexSources：CODEX_HOME 设了只认它；否则 ~/.config/codex/auth.json、~/.codex/auth.json（三平台一样）。
// 存进系统钥匙串的 Codex 登录不读：读它会弹授权框，后台服务等不到人点。
func CodexSources(goos, home string, env map[string]string) []Source {
	if h := envOf(env, "CODEX_HOME"); h != "" {
		return []Source{{File: joinFor(goos, expandHome(goos, h, home), "auth.json")}}
	}
	return []Source{
		{File: joinFor(goos, home, ".config", "codex", "auth.json")},
		{File: joinFor(goos, home, ".codex", "auth.json")},
	}
}

// OpencodeSources：OPENCODE_DATA_DIR，其次 $XDG_DATA_HOME/opencode，缺省 ~/.local/share/opencode（三平台一样）。
func OpencodeSources(goos, home string, env map[string]string) []Source {
	dir := joinFor(goos, home, ".local", "share", "opencode")
	if d := envOf(env, "OPENCODE_DATA_DIR"); d != "" {
		dir = expandHome(goos, d, home)
	} else if x := envOf(env, "XDG_DATA_HOME"); x != "" {
		dir = joinFor(goos, expandHome(goos, x, home), "opencode")
	}
	return []Source{{File: joinFor(goos, dir, "auth.json")}}
}
