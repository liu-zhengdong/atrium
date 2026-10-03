package gates_test

import "github.com/liu-zhengdong/atrium/internal/org"

func (e *env) choiceMaterial(dept string) {
	e.t.Helper()
	e.g.Data = e.t.TempDir()
	if _, err := org.AddMaterial(e.ctx, e.db, e.g.Data, org.MaterialInput{Org: dept, Note: "测试依据", Files: []org.MaterialFile{{Name: "27.svg", Content: []byte("<svg/>")}}}, "u1"); err != nil {
		e.t.Fatal(err)
	}
}
