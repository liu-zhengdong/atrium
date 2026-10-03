package web

import "testing"

func TestIdentityText(t *testing.T) {
	names := map[string]string{"a1": "甲", "a10": "乙<&\"", "u1": "你", "secretary": "秘书", "h1": "本机"}
	for _, c := range []struct{ id, want string }{
		{"a1", "甲（a1）"}, {"a10", "乙<&\"（a10）"},
		{"a99", "未登记负责人（a99）"}, {"a2", "未登记负责人（a2）"},
		{"a1\n", "a1\n"}, {"a1\r", "a1\r"}, {"a0", "a0"}, {"a01", "a01"}, {"a1 正文", "a1 正文"},
		{"u1", "你"}, {"secretary", "秘书"}, {"worker", "worker"}, {"h1", "本机"}, {"", ""},
	} {
		if got := identityText(c.id, names); got != c.want {
			t.Errorf("%q: %q，期望 %q", c.id, got, c.want)
		}
	}
	names["a1"] = "改名"
	if got := identityText("a1", names); got != "改名（a1）" {
		t.Fatal(got)
	}
	delete(names, "a1")
	if got := identityText("a1", names); got != "未登记负责人（a1）" {
		t.Fatal(got)
	}
}
