package gates

import (
	"image"
	"image/color"
	"os"
	"path/filepath"
	"testing"
)

func TestParseFFprobe(t *testing.T) {
	tests := []struct {
		name         string
		json         string
		wantWidth    int
		wantHeight   int
		wantDuration float64
		wantErr      bool
	}{
		{
			name: "正常流读取",
			json: `{
				"streams": [{"width": 1920, "height": 1080, "duration": "15.500000"}],
				"format": {"duration": "15.500000"}
			}`,
			wantWidth:    1920,
			wantHeight:   1080,
			wantDuration: 15.5,
			wantErr:      false,
		},
		{
			name: "流中无时长从format回退",
			json: `{
				"streams": [{"width": 1280, "height": 720, "duration": "N/A"}],
				"format": {"duration": "30.000000"}
			}`,
			wantWidth:    1280,
			wantHeight:   720,
			wantDuration: 30.0,
			wantErr:      false,
		},
		{
			name:    "非法JSON",
			json:    `{invalid`,
			wantErr: true,
		},
		{
			name: "无视频流",
			json: `{
				"streams": [],
				"format": {"duration": "10.0"}
			}`,
			wantErr: true,
		},
		{
			name: "时长为0",
			json: `{
				"streams": [{"width": 640, "height": 480, "duration": "0.0"}],
				"format": {"duration": "0.0"}
			}`,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			meta, err := ParseFFprobe([]byte(tt.json))
			if (err != nil) != tt.wantErr {
				t.Fatalf("ParseFFprobe() error = %v, wantErr %v", err, tt.wantErr)
			}
			if !tt.wantErr {
				if meta.Width != tt.wantWidth || meta.Height != tt.wantHeight {
					t.Errorf("分辨率 = %dx%d, want %dx%d", meta.Width, meta.Height, tt.wantWidth, tt.wantHeight)
				}
				if meta.Duration != tt.wantDuration {
					t.Errorf("时长 = %v, want %v", meta.Duration, tt.wantDuration)
				}
			}
		})
	}
}

func TestParseEbur128(t *testing.T) {
	tests := []struct {
		name    string
		output  string
		wantI   float64
		wantLRA float64
		wantErr bool
	}{
		{
			name: "正常解析",
			output: `
[Parsed_ebur128_0 @ 0x12345] Summary:

  Integrated loudness:
    I:         -21.1 LUFS
    Threshold: -31.1 LUFS

  Loudness range:
    LRA:        20.0 LU
    Threshold: -41.1 LUFS
`,
			wantI:   -21.1,
			wantLRA: 20.0,
			wantErr: false,
		},
		{
			name: "无LRA项",
			output: `
  Integrated loudness:
    I:         -14.2 LUFS
`,
			wantI:   -14.2,
			wantLRA: 0.0,
			wantErr: false,
		},
		{
			name:    "未包含响度输出",
			output:  `ffmpeg version 7.0 Copyright`,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			meta, err := ParseEbur128(tt.output)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ParseEbur128() error = %v, wantErr %v", err, tt.wantErr)
			}
			if !tt.wantErr {
				if meta.Integrated != tt.wantI {
					t.Errorf("Integrated = %v, want %v", meta.Integrated, tt.wantI)
				}
				if meta.LRA != tt.wantLRA {
					t.Errorf("LRA = %v, want %v", meta.LRA, tt.wantLRA)
				}
			}
		})
	}
}

func TestIsBlankImage(t *testing.T) {
	tests := []struct {
		name      string
		img       image.Image
		wantBlank bool
	}{
		{
			name: "全黑图片",
			img: func() image.Image {
				m := image.NewRGBA(image.Rect(0, 0, 10, 10))
				for y := 0; y < 10; y++ {
					for x := 0; x < 10; x++ {
						m.Set(x, y, color.Black)
					}
				}
				return m
			}(),
			wantBlank: true,
		},
		{
			name: "全白图片",
			img: func() image.Image {
				m := image.NewRGBA(image.Rect(0, 0, 10, 10))
				for y := 0; y < 10; y++ {
					for x := 0; x < 10; x++ {
						m.Set(x, y, color.White)
					}
				}
				return m
			}(),
			wantBlank: true,
		},
		{
			name: "纯色绿色平涂",
			img: func() image.Image {
				m := image.NewRGBA(image.Rect(0, 0, 10, 10))
				for y := 0; y < 10; y++ {
					for x := 0; x < 10; x++ {
						m.Set(x, y, color.RGBA{R: 0, G: 200, B: 0, A: 255})
					}
				}
				return m
			}(),
			wantBlank: true,
		},
		{
			name: "带微弱噪点的纯黑（极差<=2）",
			img: func() image.Image {
				m := image.NewRGBA(image.Rect(0, 0, 10, 10))
				for y := 0; y < 10; y++ {
					for x := 0; x < 10; x++ {
						if x == 0 {
							m.Set(x, y, color.RGBA{R: 1, G: 1, B: 1, A: 255})
						} else {
							m.Set(x, y, color.RGBA{R: 0, G: 0, B: 0, A: 255})
						}
					}
				}
				return m
			}(),
			wantBlank: true,
		},
		{
			name: "有内容的图案（黑白棋盘）",
			img: func() image.Image {
				m := image.NewRGBA(image.Rect(0, 0, 10, 10))
				for y := 0; y < 10; y++ {
					for x := 0; x < 10; x++ {
						if (x+y)%2 == 0 {
							m.Set(x, y, color.White)
						} else {
							m.Set(x, y, color.Black)
						}
					}
				}
				return m
			}(),
			wantBlank: false,
		},
		{
			name:      "空尺寸图片",
			img:       image.NewRGBA(image.Rect(0, 0, 0, 0)),
			wantBlank: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsBlankImage(tt.img)
			if got != tt.wantBlank {
				t.Errorf("IsBlankImage() = %v, want %v", got, tt.wantBlank)
			}
		})
	}
}

func TestFindVideoFile(t *testing.T) {
	tmp := t.TempDir()

	// 1. 无视频
	if _, err := FindVideoFile(tmp); err == nil {
		t.Errorf("无视频文件应返回错误")
	}

	// 2. 在 out 目录下有视频
	outDir := filepath.Join(tmp, "out")
	if err := os.MkdirAll(outDir, 0o700); err != nil {
		t.Fatal(err)
	}
	videoPath := filepath.Join(outDir, "render.mp4")
	if err := os.WriteFile(videoPath, []byte("fake video"), 0o600); err != nil {
		t.Fatal(err)
	}

	found, err := FindVideoFile(tmp)
	if err != nil {
		t.Fatalf("FindVideoFile() error = %v", err)
	}
	if found != videoPath {
		t.Errorf("找到的视频路径 = %q, want %q", found, videoPath)
	}
}
