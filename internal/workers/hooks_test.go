package workers

import (
	"testing"

	"github.com/liu-zhengdong/atrium/internal/watch"
)

func TestWatchSignal(t *testing.T) {
	dsh, _ := Builtin("dsh")
	cases := []struct {
		name string
		tail string
		want watch.Signal
	}{
		// 进程还活着时巡检也问：没有收尾事件就不动手，正文里的额度字样不算。
		{"在跑：正文里的额度字样不判", `{"type":"text","text":"rate limit exceeded"}`, watch.SigNone},
		{"正常收尾", `{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}`, watch.SigDone},
		{"额度收尾：报文认得出就判额度", `{"type":"status","phase":"turn_end","reason":{"kind":"error","error":{"code":"insufficient_quota","message":"Insufficient Balance"}}}`, watch.SigQuota},
		{"普通报错收尾只算 error", `{"type":"status","phase":"turn_end","reason":{"kind":"error","error":{"message":"boom"}}}`, watch.SigError},
		{"收尾行没写额度、只有更早的报错行写了：不判额度", `{"type":"error","message":"rate limit exceeded"}` + "\n" + `{"type":"status","phase":"turn_end","reason":{"kind":"aborted"}}`, watch.SigError},
	}
	for _, c := range cases {
		if got := WatchSignal(dsh, c.tail); got != c.want {
			t.Errorf("%s：%q，要 %q", c.name, got, c.want)
		}
	}
}
