package org

import "os"

// ReadFile 按资料登记的路径读取实际文件；rel 空时取正文，与 material ls 共用。
func (m Material) ReadFile(rel string) (MaterialFileInfo, []byte, error) {
	f, p, err := m.File(rel)
	if err != nil {
		return MaterialFileInfo{}, nil, err
	}
	raw, err := os.ReadFile(p)
	return f, raw, err
}
