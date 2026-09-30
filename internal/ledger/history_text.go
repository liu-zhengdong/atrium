package ledger

// HistoryText 由经历的所属模块提供行内摘要；未提供的仍显示截断的原文。
var HistoryText = map[string]func(string) string{}

func historyText(e TaskEvent) string {
	if format := HistoryText[e.Kind]; format != nil {
		return format(e.Body)
	}
	return oneLine(e.Body)
}
