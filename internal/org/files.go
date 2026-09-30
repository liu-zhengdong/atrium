package org

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/liu-zhengdong/atrium/internal/api"
)

// 技能、资料、凭据的内容都在数据目录里（库里只记元数据）：
//
//	skills/<名字>/r<rev>/SKILL.md 与附属文件
//	materials/<mN>/r<rev>/<文件名>
//	secrets/<oN>/<名称>（0600）
func skillDir(data, name string, rev int) string {
	return filepath.Join(data, "skills", name, "r"+strconv.Itoa(rev))
}

func materialFile(data, id string, rev int, name string) string {
	return filepath.Join(data, "materials", id, "r"+strconv.Itoa(rev), name)
}

func secretFile(data, dept, name string) string { return filepath.Join(data, "secrets", dept, name) }

// writeFile 先写临时文件再改名；目录 0700。
func writeFile(path string, data []byte, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Principles 现读本机（服务主机）主目录的 AGENTS.md——用户的全局原则，原文拼成提示词里的一节；文件不存在返回空。
// 执行者（含审阅者）、负责人、秘书的提示词都从这里取，放在部门要点之前：全局原则优先于部门要点。
func Principles() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	b, err := os.ReadFile(filepath.Join(home, "AGENTS.md"))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	body := strings.TrimSpace(string(b))
	if body == "" {
		return "", nil
	}
	return "## 用户的全局原则（~/AGENTS.md，优先于部门要点）\n\n" + body + "\n", nil
}

var segment = regexp.MustCompile(`^[A-Za-z0-9_\p{Han}][A-Za-z0-9._\-\p{Han}]*$`)

// CheckRelPath 纯判定：相对路径只能在目录内——不许绝对路径、..、隐藏段、反斜杠，最多 depth 层，每段 ≤100 字节。
func CheckRelPath(field, p string, depth int) error {
	segs := strings.Split(p, "/")
	if p == "" || len(segs) > depth {
		return api.Usage("%s: 路径 %q 不合法：应为目录内的相对路径，最多 %d 层", field, p, depth)
	}
	for _, s := range segs {
		if !segment.MatchString(s) || len(s) > 100 {
			return api.Usage("%s: 路径 %q 不合法：段名用字母、数字、汉字、点、下划线或连字符，不以点开头", field, p)
		}
	}
	return nil
}

// IsText 纯判定：合法 UTF-8 且不含 NUL 算文本。
func IsText(b []byte) bool { return utf8.Valid(b) && !strings.ContainsRune(string(b), 0) }

// fmtTime 把库里的毫秒时间印成本机的「09-28 14:05」。
func fmtTime(ms int64) string { return time.UnixMilli(ms).Local().Format("01-02 15:04") }
