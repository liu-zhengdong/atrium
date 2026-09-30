package config

import "testing"

func TestPort(t *testing.T) {
	def, err := Resolve(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	isolated := Paths{Data: t.TempDir()}
	cases := []struct {
		name string
		p    Paths
		env  string
		want int
		bad  bool
	}{
		{"缺省目录没设端口用 4320", def, "", DefaultPort, false},
		{"隔离目录没设端口交给系统挑", isolated, "", 0, false},
		{"隔离目录设了端口照用", isolated, "4391", 4391, false},
		{"缺省目录设了端口照用", def, "4391", 4391, false},
		{"端口不合法", isolated, "70000", 0, true},
	}
	for _, c := range cases {
		got, err := Port(c.p, func(k string) string {
			if k == "ATRIUM_PORT" {
				return c.env
			}
			return ""
		})
		if (err != nil) != c.bad || got != c.want {
			t.Errorf("%s：得到 %d, %v", c.name, got, err)
		}
	}
}
