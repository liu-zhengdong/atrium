package agenda

import (
	"context"
	"net/url"
	"regexp"
	"strings"
	"unicode"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 识别自由文字和 Markdown 链接中的 mN[/相对路径]；不要求自由文字改写为引用。
var materialMention = regexp.MustCompile(`m[1-9][0-9]*(?:/[^\s\x60"'<>\[\]()（）。，；：、！？]+)?`)

func evidenceRefs(text string) []string {
	var refs []string
	for _, loc := range materialMention.FindAllStringIndex(text, -1) {
		if loc[0] > 0 {
			prev := []rune(text[:loc[0]])
			r := prev[len(prev)-1]
			if r <= unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_') {
				continue
			}
		}
		if loc[1] < len(text) && !strings.Contains(text[loc[0]:loc[1]], "/") {
			r := []rune(text[loc[1]:])[0]
			if r <= unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_') {
				continue
			}
		}
		refs = append(refs, strings.TrimRight(text[loc[0]:loc[1]], ".,;:!?"))
	}
	return refs
}

func checkEvidence(ctx context.Context, q store.Querier, options []OptionInput) error {
	for i, o := range options {
		for _, ref := range evidenceRefs(o.Evidence) {
			id, rel, _ := strings.Cut(ref, "/")
			rel, _, _ = strings.Cut(rel, "#")
			rel, _, _ = strings.Cut(rel, "?")
			m, err := org.GetMaterial(ctx, q, "", id, 0)
			if err == nil && rel != "" {
				var decoded string
				decoded, err = url.PathUnescape(rel)
				if err == nil {
					_, _, err = m.File(decoded)
				}
			}
			if err != nil {
				return api.Usage("options[%d].evidence: 依据 %s 无法取得：%s", i+1, ref, err.Error())
			}
		}
	}
	return nil
}
