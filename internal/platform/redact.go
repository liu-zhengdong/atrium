package platform

import (
	"bytes"
	"io"
	"sort"
	"strings"
)

// Redacted 是凭据值在子进程日志里的占位。
const Redacted = "[REDACTED]"

// secretMinLen 之下的值不脱敏：太短的值（开关、编号）全文替换会毁掉无关内容，也不构成泄漏。
const secretMinLen = 8

// SecretEnvValues 取环境变量里凭据类的值：名字命中 sensitiveName（启动时要拦的凭据名单），或以
// TOKEN/KEY/SECRET/PASSWORD/PASSWD 结尾——执行者端点密钥与任务凭据的变量名由档案和用户起，比那份名单更宽；
// 值不足 secretMinLen 的不算。纯函数，结果排序，替换行为确定。
func SecretEnvValues(env map[string]string) []string {
	var vals []string
	for k, v := range env {
		if len(v) < secretMinLen {
			continue
		}
		name := strings.ToUpper(k)
		if !sensitiveName.MatchString(name) && !hasSecretSuffix(name) {
			continue
		}
		vals = append(vals, v)
	}
	sort.Strings(vals)
	return vals
}

func hasSecretSuffix(name string) bool {
	for _, s := range []string{"_TOKEN", "_KEY", "_SECRET", "_PASSWORD", "_PASSWD"} {
		if strings.HasSuffix(name, s) {
			return true
		}
	}
	return false
}

// RedactLog 把子进程会话日志的写入包一层：凭据值在落盘前替换成 Redacted，执行者把环境变量打进
// 输出（printenv、echo $TOKEN）也不落明文。按行缓冲：没凑齐换行符的尾巴攒到下一行或 Close
// （进程退出、拷贝结束后调用）再落盘。没有凭据值时原样返回 w。Close 只冲残余缓冲，不关底层
// writer，文件照旧由调用方关。
func RedactLog(w io.Writer, env map[string]string) io.WriteCloser {
	vals := SecretEnvValues(env)
	if len(vals) == 0 {
		return passthrough{w}
	}
	pairs := make([]string, 0, len(vals)*2)
	for _, v := range vals {
		pairs = append(pairs, v, Redacted)
	}
	return &redactWriter{w: w, re: strings.NewReplacer(pairs...)}
}

type passthrough struct{ io.Writer }

func (passthrough) Close() error { return nil }

type redactWriter struct {
	w   io.Writer
	re  *strings.Replacer
	buf []byte
}

func (r *redactWriter) Write(p []byte) (int, error) {
	r.buf = append(r.buf, p...)
	if i := bytes.LastIndexByte(r.buf, '\n'); i >= 0 {
		if err := r.flushTo(i + 1); err != nil {
			return 0, err
		}
	}
	return len(p), nil
}

// Close 冲掉攒着的最后一截（多半是不带换行符的尾行）。
func (r *redactWriter) Close() error {
	if len(r.buf) == 0 {
		return nil
	}
	return r.flushTo(len(r.buf))
}

func (r *redactWriter) flushTo(n int) error {
	if _, err := r.re.WriteString(r.w, string(r.buf[:n])); err != nil {
		return err
	}
	rest := copy(r.buf, r.buf[n:])
	r.buf = r.buf[:rest]
	return nil
}
