package org

import "testing"

func TestDisplayIdentity(t *testing.T) {
	names := map[string]string{"a1": "Atrium 负责人", "a10": "命令行和网页负责人", "a2": "长名\n含（括号）<&>\"", "a0": "无效", "a10x": "无效", "u1": "用户"}
	for _, c := range []struct{ id, want string }{
		{"a1", "Atrium 负责人（a1）"}, {"a10", "命令行和网页负责人（a10）"},
		{"a99", "未登记负责人（a99）"}, {"a2", "长名\n含（括号）<&>\"（a2）"},
		{"u1", "u1"}, {"secretary", "secretary"}, {"worker", "worker"}, {"gates", "gates"},
		{"kimi@h3", "kimi@h3"}, {"h1", "h1"}, {"a0", "a0"}, {"a10x", "a10x"},
		{"a01", "a01"}, {"a", "a"}, {"", ""}, {"正文 a1", "正文 a1"}, {"a1/a10", "a1/a10"},
		{"a-1", "a-1"}, {"a１", "a１"}, {"a1\n", "a1\n"},
	} {
		t.Run(c.id, func(t *testing.T) {
			if got := DisplayIdentity(c.id, names); got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
	names["a1"] = "新名"
	if got := DisplayIdentity("a1", names); got != "新名（a1）" {
		t.Fatal(got)
	}
	delete(names, "a1")
	if got := DisplayIdentity("a1", names); got != "未登记负责人（a1）" {
		t.Fatal(got)
	}
	if got := DisplayIdentity("a10", nil); got != "未登记负责人（a10）" {
		t.Fatal(got)
	}
}
