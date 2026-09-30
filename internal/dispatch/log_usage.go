package dispatch

import "fmt"

func logHeader(id string, ch LogChunk) string {
	s := fmt.Sprintf("== %s 第 %d 次拉起（%s）", id, ch.Run, ch.Worker)
	if !ch.Running {
		s += " · " + ch.Usage.String()
	}
	return s
}
