package release

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
	if (Config{Enabled: true, Repo: "o/r"}).Tracks("o/x") || !(Config{Enabled: true, Repo: "o/r"}).Tracks("o/r") ||
		(Config{Repo: "o/r"}).Tracks("o/r") {
		t.Error("Tracks 判定不对")
	}
}
