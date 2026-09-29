package gates

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"sort"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// CheckContext 是技能交付检查执行时的上下文。
type CheckContext struct {
	Context context.Context
	Task    ledger.Task
	WorkDir string // 工作地点或工作树绝对路径
	TaskDir string // 任务目录绝对路径（用于存放产物如截图、联系表）
	Runner  Runner
	DB      *store.DB
	Data    string
	Log     *slog.Logger
}

// CheckResult 是单项技能检查的执行结果。
type CheckResult struct {
	Check     string   `json:"check"`
	OK        bool     `json:"ok"`
	Evidence  string   `json:"evidence"`
	Artifacts []string `json:"artifacts,omitempty"`
}

// SkillChecker 是技能检查项的执行函数类型。
type SkillChecker func(c CheckContext) (CheckResult, error)

// SkillCheckRegistry 是检查名到具体实现的注册表。
var SkillCheckRegistry = map[string]SkillChecker{
	"site_build":         checkSiteBuild,
	"pnpm_build":         checkSiteBuild,
	"article_screenshot": checkArticleScreenshot,
	"article_preview":    checkArticleScreenshot,
	"article":            checkArticle,
	"video_probe":        checkVideoProbe,
	"video_frames":       checkVideoFrames,
	"video":              checkVideo,
}

// KnownSkillChecks 返回所有已注册的技能检查项名称（字母排序）。
func KnownSkillChecks() []string {
	keys := make([]string, 0, len(SkillCheckRegistry))
	for k := range SkillCheckRegistry {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// RunSkillChecks 执行指定的技能检查项列表。
func RunSkillChecks(cctx CheckContext, checks []string) ([]CheckResult, bool, []string, []string, error) {
	var (
		results      []CheckResult
		reasons      []string
		allArtifacts []string
		allPassed    = true
	)

	for _, name := range checks {
		checker, ok := SkillCheckRegistry[name]
		if !ok {
			allPassed = false
			reason := fmt.Sprintf("未知技能检查项 %q（可用：%s）", name, strings.Join(KnownSkillChecks(), "、"))
			reasons = append(reasons, reason)
			results = append(results, CheckResult{Check: name, OK: false, Evidence: reason})
			continue
		}
		res, err := checker(cctx)
		if err != nil {
			return nil, false, nil, nil, err
		}
		results = append(results, res)
		for _, a := range res.Artifacts {
			if !slices.Contains(allArtifacts, a) {
				allArtifacts = append(allArtifacts, a)
			}
		}
		if !res.OK {
			allPassed = false
			reasons = append(reasons, name+"："+res.Evidence)
		}
	}

	return results, allPassed, reasons, allArtifacts, nil
}
