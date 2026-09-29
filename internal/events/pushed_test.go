package events

import (
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
)

func TestPushed(t *testing.T) {
	cases := []struct {
		name      string
		a         api.Actor
		listening bool
		want      bool
	}{
		{"负责人由唤醒送达", api.Actor{ID: "a1", Kind: "leader"}, false, true},
		{"秘书在听", api.Actor{ID: Secretary, Kind: "user"}, true, true},
		{"秘书不在听", api.Actor{ID: Secretary, Kind: "user"}, false, false},
		{"用户自己在终端里", api.Actor{ID: "u1", Kind: "user"}, true, false},
	}
	for _, c := range cases {
		if got := Pushed(c.a, c.listening); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}
