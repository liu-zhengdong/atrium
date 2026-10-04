package workers

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 风险与信任的档位（从低到高）。
var (
	Risks  = []string{"low", "medium", "high"}
	Trusts = []string{"unknown", "low", "medium", "high"}
)

// Rules 是档案 frontmatter 的规则。三层叠加后以最具体的一层为准（整项覆盖，checks 写 [] 表示不加查）。
type Rules struct {
	Billing     string     `yaml:"billing,omitempty" json:"billing,omitempty"`
	Prices      *Prices    `yaml:"prices,omitempty" json:"prices,omitempty"`
	Auto        *bool      `yaml:"auto,omitempty" json:"auto,omitempty"`     // nil：缺省参与自动挑人
	Prefer      bool       `yaml:"prefer,omitempty" json:"prefer,omitempty"` // 自动挑人时排在没标的前面（仍在技能偏好之后、近期不稳之外）
	Trust       string     `yaml:"trust,omitempty" json:"trust,omitempty"`
	MaxRisk     string     `yaml:"max_risk,omitempty" json:"max_risk,omitempty"`
	Checks      []string   `yaml:"checks,omitempty" json:"checks,omitempty"` // nil：没写（交付检查用缺省）；空：不加查
	Model       string     `yaml:"model,omitempty" json:"model,omitempty"`
	Endpoint    string     `yaml:"endpoint,omitempty" json:"endpoint,omitempty"`
	EndpointAPI string     `yaml:"endpoint_api,omitempty" json:"endpoint_api,omitempty"`
	EndpointKey string     `yaml:"endpoint_key,omitempty" json:"endpoint_key,omitempty"` // 凭据名，值分派任务时注入
	Protocol    string     `yaml:"protocol,omitempty" json:"protocol,omitempty"`         // 只在 harness 层：cli
	Usage       *UsageSpec `yaml:"usage,omitempty" json:"usage,omitempty"`               // 从 JSON 日志取用量的字段路径
	CLISpec     `yaml:",inline" json:"-"`
}

// TrustLevel、RiskLevel 是档位序号；不认识返回 -1。
func TrustLevel(t string) int { return slices.Index(Trusts, t) }
func RiskLevel(r string) int  { return slices.Index(Risks, r) }

// EffectiveTrust：没写按 unknown。
func (r Rules) EffectiveTrust() string {
	if r.Trust == "" {
		return "unknown"
	}
	return r.Trust
}

// EffectiveMaxRisk：没写 max_risk 时按信任推：unknown、low 只接 low，medium 接到 medium，high 接到 high。
func (r Rules) EffectiveMaxRisk() string {
	if r.MaxRisk != "" {
		return r.MaxRisk
	}
	switch r.EffectiveTrust() {
	case "high":
		return "high"
	case "medium":
		return "medium"
	}
	return "low"
}

// Profile 是一层档案的原文与解析结果。
type Profile struct {
	Name      string         `json:"name"` // 层/名，如 harness/claude
	Source    string         `json:"source"`
	Keys      map[string]any `json:"-"`
	Body      string         `json:"body"`
	UpdatedBy string         `json:"updated_by"`
	UpdatedAt int64          `json:"updated_at"`
}

var checkNameRE = regexp.MustCompile(`^[a-z_]+$`)

// 模型段用 modelSeg（见 adapter.go）：models、combos 名里的模型可带方括号档位后缀（GLM-5.3[1m]）。
var layerNameRE = regexp.MustCompile(`^(harness|models|combos)/([\w.@-]+(\+` + modelSeg + `)?)$`)

// CheckName 校验档案名：harness/<工具>、models/<模型>、combos/<工具>+<模型>（模型取最后一段，不带 provider 前缀）。
func CheckName(name string) error {
	m := layerNameRE.FindStringSubmatch(name)
	if m == nil || strings.HasPrefix(m[2], ".") {
		return api.Usage("档案名应为 harness/<工具>、models/<模型> 或 combos/<工具>+<模型>，收到 %q", name)
	}
	if (m[1] == "combos") != (m[3] != "") {
		return api.Usage("档案名 %s：只有 combos 层写 <工具>+<模型>", name)
	}
	return nil
}

// SplitSource 拆出 frontmatter（YAML）与正文。纯函数。
func SplitSource(src string) (map[string]any, string, error) {
	src = strings.ReplaceAll(strings.TrimPrefix(src, "\ufeff"), "\r\n", "\n")
	keys := map[string]any{}
	if !strings.HasPrefix(src, "---\n") {
		return keys, strings.TrimSpace(src), nil
	}
	head, body, ok := strings.Cut(src[4:], "\n---")
	if !ok {
		return nil, "", api.Usage("档案开头的 --- 没有配对的结束 ---")
	}
	if err := yaml.Unmarshal([]byte(head), &keys); err != nil {
		return nil, "", api.Usage("档案 frontmatter 不是合法 YAML：%v", err)
	}
	if keys == nil {
		keys = map[string]any{}
	}
	return keys, strings.TrimSpace(strings.TrimPrefix(body, "\n")), nil
}

// JoinSource 把规则与正文拼回原文（键按字母序）。纯函数。
func JoinSource(keys map[string]any, body string) string {
	var b strings.Builder
	if len(keys) > 0 {
		out, _ := yaml.Marshal(keys)
		b.WriteString("---\n")
		b.Write(out)
		b.WriteString("---\n")
	}
	if body != "" {
		b.WriteString(body)
		b.WriteString("\n")
	}
	return b.String()
}

// decodeRules 把键解成 Rules，拒绝不认识的键。
func decodeRules(keys map[string]any) (Rules, error) {
	var r Rules
	raw, err := yaml.Marshal(keys)
	if err != nil {
		return r, err
	}
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&r); err != nil && err.Error() != "EOF" {
		return r, api.Usage("档案规则写得不对：%v", err)
	}
	return r, nil
}

var cliKeys = []string{"protocol", "command", "args", "model_args", "effort_args", "endpoint_args", "efforts", "done_match",
	"error_match", "env", "endpoint_apis", "key_env", "exclusive", "json"}

// CheckProfile 校验一层档案（纯函数）：键都认识、取值在档位内、通用命令行写法只在 harness 层且写得对。
func CheckProfile(name string, keys map[string]any) error {
	if err := CheckName(name); err != nil {
		return err
	}
	r, err := decodeRules(keys)
	if err != nil {
		return err
	}
	layer, rest, _ := strings.Cut(name, "/")
	var p []string
	p = append(p, r.billingProblems()...)
	p = append(p, r.usageProblems()...)
	if r.Trust != "" && TrustLevel(r.Trust) < 0 {
		p = append(p, "trust 只能是 "+strings.Join(Trusts, "、"))
	}
	if r.MaxRisk != "" && RiskLevel(r.MaxRisk) < 0 {
		p = append(p, "max_risk 只能是 "+strings.Join(Risks, "、"))
	}
	for _, c := range r.Checks {
		if !checkNameRE.MatchString(c) {
			p = append(p, fmt.Sprintf("checks 里的 %q 不是交付检查名", c))
		}
	}
	if r.Model != "" && !modelRE.MatchString(r.Model) {
		p = append(p, "model 不合法："+r.Model)
	}
	if r.Endpoint != "" || r.EndpointAPI != "" || r.EndpointKey != "" {
		if u, err := url.Parse(r.Endpoint); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			p = append(p, "endpoint 须是 http(s) 地址")
		}
		if !slices.Contains(EndpointAPIs, r.EndpointAPI) {
			p = append(p, "endpoint_api 只能是 "+strings.Join(EndpointAPIs, "、"))
		}
		if r.EndpointKey != "" && !envNameRE.MatchString(r.EndpointKey) {
			p = append(p, "endpoint_key 是凭据名（大写字母、数字、下划线）")
		}
	}
	hasCLI := false
	for _, k := range cliKeys {
		if _, ok := keys[k]; ok {
			hasCLI = true
		}
	}
	switch {
	case hasCLI && layer != "harness":
		p = append(p, "protocol、command、args 这类通用命令行写法只能写在 harness 层")
	case hasCLI && r.Protocol != "cli":
		p = append(p, "通用命令行执行者要写 protocol: cli")
	case hasCLI:
		p = append(p, r.CLISpec.Problems(rest)...)
	case layer == "harness":
		if _, ok := builtin[rest]; !ok {
			p = append(p, fmt.Sprintf("%s 不是内置工具（%s）；接新工具写 protocol: cli 与 command、args", rest, strings.Join(Tools, "、")))
		}
	}
	if len(p) > 0 {
		return api.Usage("档案 %s：%s", name, strings.Join(p, "；"))
	}
	return nil
}

// GetProfile 读一层档案；没有返回 nil。
func GetProfile(ctx context.Context, q store.Querier, name string) (*Profile, error) {
	p := Profile{Name: name}
	err := q.QueryRowContext(ctx, `SELECT spec, updated_by, updated_at FROM worker_profiles WHERE name = ?`, name).
		Scan(&p.Source, &p.UpdatedBy, &p.UpdatedAt)
	if store.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if p.Keys, p.Body, err = SplitSource(p.Source); err != nil {
		return nil, fmt.Errorf("档案 %s 原文坏了：%w", name, err)
	}
	return &p, nil
}

const maxProfiles = 500

// ListProfiles 列全部档案（按名字）。
func ListProfiles(ctx context.Context, q store.Querier) ([]Profile, error) {
	rows, err := q.QueryContext(ctx, `SELECT name, spec, updated_by, updated_at FROM worker_profiles ORDER BY name LIMIT ?`, maxProfiles)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Profile
	for rows.Next() {
		var p Profile
		if err := rows.Scan(&p.Name, &p.Source, &p.UpdatedBy, &p.UpdatedAt); err != nil {
			return nil, err
		}
		if p.Keys, p.Body, err = SplitSource(p.Source); err != nil {
			return nil, fmt.Errorf("档案 %s 原文坏了：%w", p.Name, err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

const maxProfileBytes = 16 * 1024

// Edit 是 workers 改档案的输入：Source 整份替换；Set/Unset 改 frontmatter 的键（值按 YAML 解析）；Delete 删掉这层。
type Edit struct {
	Source *string           `json:"source,omitempty"`
	Set    map[string]string `json:"set,omitempty"`
	Unset  []string          `json:"unset,omitempty"`
	Delete bool              `json:"delete,omitempty"`
}

// ApplyEdit 算出改后的原文（纯函数）；old 为空表示新建。
func ApplyEdit(name, old string, e Edit) (string, error) {
	src := old
	if e.Source != nil {
		src = *e.Source
	}
	keys, body, err := SplitSource(src)
	if err != nil {
		return "", err
	}
	for k, v := range e.Set {
		var val any
		if err := yaml.Unmarshal([]byte(v), &val); err != nil {
			return "", api.Usage("--set %s: 值不是合法 YAML：%v", k, err)
		}
		keys[k] = val
	}
	for _, k := range e.Unset {
		if _, ok := keys[k]; !ok {
			return "", api.Usage("--unset: 档案 %s 没有 %s", name, k)
		}
		delete(keys, k)
	}
	if err := CheckProfile(name, keys); err != nil {
		return "", err
	}
	out := JoinSource(keys, body)
	if len(out) > maxProfileBytes {
		return "", api.Usage("档案 %s 有 %d 字节，超过上限 %d：正文只写这个执行者特有的叮嘱", name, len(out), maxProfileBytes)
	}
	return out, nil
}

// SaveProfile 按 Edit 改一层档案并落库；返回改后的档案（删掉时为 nil）。
func SaveProfile(ctx context.Context, db *store.DB, name string, e Edit, actor string) (*Profile, error) {
	if err := CheckName(name); err != nil {
		return nil, err
	}
	if e.Source == nil && len(e.Set) == 0 && len(e.Unset) == 0 && !e.Delete {
		return nil, api.Usage("没有要改的：给 --file、--set、--unset 或 --delete")
	}
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		old, err := GetProfile(ctx, tx, name)
		if err != nil {
			return err
		}
		if e.Delete {
			if old == nil {
				return api.NotFound("档案 %s 不存在", name).WithNext("atrium workers")
			}
			_, err := tx.ExecContext(ctx, `DELETE FROM worker_profiles WHERE name = ?`, name)
			return err
		}
		prev := ""
		if old != nil {
			prev = old.Source
		}
		src, err := ApplyEdit(name, prev, e)
		if err != nil {
			return err
		}
		if old == nil {
			var n int
			if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM worker_profiles`).Scan(&n); err != nil {
				return err
			}
			if n >= maxProfiles {
				return api.Limit("atrium workers", "档案已有 %d 份（上限 %d）：删掉不再用的组合（atrium workers edit combos/… --delete）", n, maxProfiles)
			}
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO worker_profiles (name, spec, updated_by, updated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (name) DO UPDATE SET spec = excluded.spec, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
			name, src, actor, store.Now())
		return err
	})
	if err != nil || e.Delete {
		return nil, err
	}
	return GetProfile(ctx, db, name)
}
