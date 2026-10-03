package workers

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

// kimi（2.1.1）的 stream-json 不带用量，每步用量只写在它自己的会话目录：
// $KIMI_CODE_HOME（缺省 ~/.kimi-code）/sessions/<工作区>/<会话>/agents/<agent>/wire.jsonl 里的 usage.record 行。
// 执行者退出后，由拉起它的那台机器（本机或远程代理）读出合计，以一行 atrium.usage 追加到本次日志末尾；
// 之后结算、重新结算、远程续传都只看日志，不再碰会话目录。
const kimiUsageType = "atrium.usage"

var kimiSessionRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// AfterExit 在执行者退出后补记工具没写进日志的用量（目前只有 kimi）；env 是执行者的环境，用来找工具的数据目录。
// 读不到时也追加一行写明原因，日志里看得见为什么用量读不到。
func AfterExit(tool, log string, env map[string]string) error {
	if tool != "kimi" {
		return nil
	}
	tr, err := ReadTrace("kimi", log)
	if err != nil {
		return err
	}
	line := map[string]any{"role": "meta", "type": kimiUsageType}
	if u, err := kimiSessionUsage(kimiHome(env), tr.Session); err != nil {
		line["missing"] = err.Error()
	} else {
		line["usage"] = u
	}
	b, err := json.Marshal(line)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(log, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(append(append([]byte("\n"), b...), '\n'))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

func kimiHome(env map[string]string) string {
	if h := env["KIMI_CODE_HOME"]; h != "" {
		return h
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".kimi-code")
}

// kimiUsage 是 kimi 一步的用量，字段同它的 usage.record。
type kimiUsage struct {
	InputOther         int64 `json:"inputOther"`
	Output             int64 `json:"output"`
	InputCacheRead     int64 `json:"inputCacheRead"`
	InputCacheCreation int64 `json:"inputCacheCreation"`
}

func kimiSessionUsage(home, session string) (kimiUsage, error) {
	if session == "" {
		return kimiUsage{}, fmt.Errorf("日志里没有会话 id（session.resume_hint）")
	}
	if !kimiSessionRE.MatchString(session) {
		return kimiUsage{}, fmt.Errorf("会话 id 不合法：%q", session)
	}
	if home == "" {
		return kimiUsage{}, fmt.Errorf("找不到 kimi 的数据目录")
	}
	files, err := filepath.Glob(filepath.Join(home, "sessions", "*", session, "agents", "*", "wire.jsonl"))
	if err != nil {
		return kimiUsage{}, err
	}
	if len(files) == 0 {
		return kimiUsage{}, fmt.Errorf("会话 %s 的目录里没有 wire.jsonl", session)
	}
	var sum kimiUsage
	for _, path := range files {
		f, err := os.Open(path)
		if err != nil {
			return kimiUsage{}, err
		}
		u, err := sumKimiWire(f)
		f.Close()
		if err != nil {
			return kimiUsage{}, fmt.Errorf("%s：%w", filepath.Base(filepath.Dir(path)), err)
		}
		sum.add(u)
	}
	return sum, nil
}

// sumKimiWire 合计一份 wire.jsonl 里全部 usage.record（每条只计一次，turn 与 session 范围不重叠）；坏的 usage.record 报错，不拿部分读数当合计。
func sumKimiWire(r io.Reader) (kimiUsage, error) {
	var sum kimiUsage
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for sc.Scan() {
		var rec struct {
			Type  string          `json:"type"`
			Usage json.RawMessage `json:"usage"`
		}
		if json.Unmarshal(sc.Bytes(), &rec) != nil || rec.Type != "usage.record" {
			continue
		}
		var u kimiUsage
		if len(rec.Usage) == 0 || json.Unmarshal(rec.Usage, &u) != nil {
			return kimiUsage{}, fmt.Errorf("usage.record 的 usage 读不了：%.200s", rec.Usage)
		}
		sum.add(u)
	}
	return sum, sc.Err()
}

func (s *kimiUsage) add(u kimiUsage) {
	s.InputOther += u.InputOther
	s.Output += u.Output
	s.InputCacheRead += u.InputCacheRead
	s.InputCacheCreation += u.InputCacheCreation
}

// readKimiUsage 读 AfterExit 追加的那一行。
func readKimiUsage(p *Parser, e event) {
	u := e.obj("usage")
	if u == nil {
		p.raw("用量读不到：" + e.str("missing"))
		return
	}
	p.addUsage(Usage{Tokens: Tokens{Input: number(u, "inputOther"), Output: number(u, "output"), CacheRead: number(u, "inputCacheRead"), CacheWrite: number(u, "inputCacheCreation")}})
}
