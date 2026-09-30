package workers

import (
	"context"
	"fmt"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/quota"
)

func showWithQuota(ctx context.Context, env *app.Env, name string) (Detail, error) {
	d, err := Show(ctx, env.DB, name)
	if err != nil || d.Resolved == nil {
		return d, err
	}
	ov, err := quota.Last(ctx, env)
	if err != nil {
		return Detail{}, err
	}
	line := quotaFor(d.Resolved.Account(), ov.Lines)
	d.Quota = &line
	return d, nil
}

func quotaFor(tool string, lines []quota.Line) quota.Line {
	account := quota.AccountOf(tool)
	for _, line := range lines {
		if line.Account == account {
			return line
		}
	}
	return quota.Line{Pace: quota.Pace{Account: account}}
}

func quotaText(line quota.Line) string {
	text := line.Account + "  "
	switch {
	case line.UsedPercent == nil:
		text += "没有额度读数"
	case line.SparePercent == nil:
		text += "有额度读数，富余未知"
	default:
		text += fmt.Sprintf("富余 %+.1f%%", *line.SparePercent)
	}
	if line.Stale {
		text += "（旧读数）"
	}
	return text
}
