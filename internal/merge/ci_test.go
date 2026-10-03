package merge

import "testing"

func TestCIJudge(t *testing.T) {
	pass := ciCheck{Name: "check", Bucket: "pass", Link: "https://ci/1"}
	fail := ciCheck{Name: "check", Bucket: "fail", Link: "https://ci/1"}
	cases := []struct {
		name    string
		checks  []ciCheck
		verdict ciVerdict
		red     ciCheck
	}{
		{"没有 checks", nil, ciEmpty, ciCheck{}},
		{"全过", []ciCheck{pass, {Name: "e2e", Bucket: "pass", Link: "https://ci/2"}}, ciGreen, ciCheck{}},
		{"跳过不算失败也不算在等", []ciCheck{pass, {Name: "win", Bucket: "skipping", Link: "https://ci/3"}}, ciGreen, ciCheck{}},
		{"有失败", []ciCheck{pass, fail}, ciRed, fail},
		{"取消按红", []ciCheck{{Name: "check", Bucket: "cancel", Link: "https://ci/1"}}, ciRed,
			ciCheck{Name: "check", Bucket: "cancel", Link: "https://ci/1"}},
		{"在等", []ciCheck{pass, {Name: "e2e", Bucket: "pending", Link: "https://ci/2"}}, ciPending, ciCheck{}},
		{"红优先于在等", []ciCheck{fail, {Name: "e2e", Bucket: "pending", Link: "https://ci/2"}}, ciRed, fail},
		{"认不得的结论按在等", []ciCheck{{Name: "check", Bucket: "queued", Link: "https://ci/1"}}, ciPending, ciCheck{}},
	}
	for _, c := range cases {
		verdict, red := ciJudge(c.checks)
		if verdict != c.verdict || red != c.red {
			t.Errorf("%s：得 %v %+v，要 %v %+v", c.name, verdict, red, c.verdict, c.red)
		}
	}
}
