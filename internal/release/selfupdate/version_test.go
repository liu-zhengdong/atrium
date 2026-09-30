package selfupdate

import "testing"

func TestVersion(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"v2.0.1", "v2.0.0", 1},
		{"v2.0.10", "v2.0.9", 1},
		{"2.1.0", "v2.1.0", 0},
		{"v2.0.0", "v10.0.0", -1},
		{"v2-dev", "v2.0.0", -1},
		{"v2.0.0", "v2-dev", 1},
		{"v2-dev", "wat", 0},
		{"v2.0.0-rc.1", "v1.0.0", -1},
		{"v2.01.0", "v2.0.0", -1}, // 前导零不算发版版本
	}
	for _, c := range cases {
		if got := Compare(c.a, c.b); got != c.want {
			t.Errorf("Compare(%s, %s) = %d，期望 %d", c.a, c.b, got, c.want)
		}
	}
	if got := Newest([]string{"v0.1.162", "v2.0.2", "v2.0.10", "nightly", "v2.0.3"}); got != "v2.0.10" {
		t.Errorf("Newest = %s", got)
	}
	if Newest([]string{"x"}) != "" {
		t.Error("没有发版版本应为空")
	}
}

func TestAsset(t *testing.T) {
	cases := map[[2]string]string{
		{"darwin", "arm64"}:  "atrium-darwin-arm64",
		{"linux", "amd64"}:   "atrium-linux-amd64",
		{"windows", "amd64"}: "atrium-windows-amd64.exe",
	}
	for in, want := range cases {
		if got := Asset(in[0], in[1]); got != want {
			t.Errorf("%v：%s", in, got)
		}
	}
}

func TestSelfUpgrade(t *testing.T) {
	cases := []struct {
		data, version string
		on            bool
	}{
		{"/home/u/.atrium-v2", "v2.0.1", true},
		{"/home/u/.atrium-v2/", "v2.0.1", true},
		{"/tmp/iso", "v2.0.1", false},
		{"/home/u/.atrium-v2", "v2-dev", false},
	}
	for _, c := range cases {
		on, why := SelfUpgrade(c.data, "/home/u/.atrium-v2", c.version)
		if on != c.on || (!on && why == "") {
			t.Errorf("%+v：%v %q", c, on, why)
		}
	}
}

func TestUpgrade(t *testing.T) {
	cases := []struct {
		name, current, latest string
		enabled, paused       bool
		failed                string
		want                  bool
	}{
		{"有新版本", "v2.0.6", "v2.0.7", true, false, "", true},
		{"已是最新", "v2.0.7", "v2.0.7", true, false, "", false},
		{"发布比运行中旧", "v2.0.8", "v2.0.7", true, false, "", false},
		{"还没有发布", "v2.0.6", "", true, false, "", false},
		{"没开自升级（隔离实例或开发版）", "v2.0.6", "v2.0.7", false, false, "", false},
		{"全局暂停", "v2.0.6", "v2.0.7", true, true, "", false},
		{"这个版本升失败过", "v2.0.6", "v2.0.7", true, false, "v2.0.7", false},
		{"升失败后又出更新的版本", "v2.0.6", "v2.0.8", true, false, "v2.0.7", true},
		{"代理旧于服务", "v2.0.5", "v2.0.91", true, false, "", true},
		{"代理新于服务（服务还没升）", "v2.0.92", "v2.0.91", true, false, "", false},
		{"服务是开发版", "v2.0.5", "v2-dev", true, false, "", false},
	}
	for _, c := range cases {
		if got := Upgrade(c.current, c.latest, c.enabled, c.paused, c.failed); got != c.want {
			t.Errorf("%s：得到 %v", c.name, got)
		}
	}
}

func TestRepo(t *testing.T) {
	env := func(v string) func(string) string { return func(string) string { return v } }
	if Repo(env("")) != DefaultRepo || Repo(env(" me/fork ")) != "me/fork" {
		t.Error("Repo 判定不对")
	}
}
