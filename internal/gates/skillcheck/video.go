package skillcheck

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// renderDir 是 Remotion 的渲染输出目录：只查这里的成片，不查 public/ 里的素材。
const renderDir = "out"

// videoExts 是认作成片的扩展名。
var videoExts = []string{".mp4", ".mov", ".webm", ".mkv"}

// Newest 从渲染输出目录的文件里取最近写出的成片（纯函数）；没有返回空。
func Newest(files []fs.FileInfo) string {
	var best fs.FileInfo
	for _, f := range files {
		ext := strings.ToLower(filepath.Ext(f.Name()))
		ok := false
		for _, v := range videoExts {
			ok = ok || ext == v
		}
		if ok && !f.IsDir() && (best == nil || f.ModTime().After(best.ModTime())) {
			best = f
		}
	}
	if best == nil {
		return ""
	}
	return best.Name()
}

// Meta 是 ffprobe 读出的成片事实。
type Meta struct {
	Width, Height int
	Duration      float64 // 秒
	Audio         bool
}

// ParseProbe 解析 ffprobe -show_entries stream=codec_type,width,height:format=duration -of json 的输出（纯函数）。
func ParseProbe(out string) (Meta, error) {
	var raw struct {
		Streams []struct {
			Type   string `json:"codec_type"`
			Width  int    `json:"width"`
			Height int    `json:"height"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal([]byte(out), &raw); err != nil {
		return Meta{}, fmt.Errorf("ffprobe 的输出不是 JSON：%v", err)
	}
	var m Meta
	for _, s := range raw.Streams {
		switch {
		case s.Type == "video" && m.Width == 0:
			m.Width, m.Height = s.Width, s.Height
		case s.Type == "audio":
			m.Audio = true
		}
	}
	m.Duration, _ = strconv.ParseFloat(raw.Format.Duration, 64)
	switch {
	case m.Width <= 0 || m.Height <= 0:
		return m, errors.New("没有视频流")
	case m.Duration <= 0:
		return m, errors.New("读不出时长")
	}
	return m, nil
}

// ParseLoudness 从 ebur128=metadata=1 经 ametadata 写出的逐帧记录里取最后一帧的综合响度与响度范围（纯函数）。
func ParseLoudness(text string) (integrated, lra float64, err error) {
	var gotI, gotLRA bool
	for _, line := range strings.Split(text, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		switch k {
		case "lavfi.r128.I":
			integrated, err = strconv.ParseFloat(v, 64)
			gotI = err == nil
		case "lavfi.r128.LRA":
			lra, err = strconv.ParseFloat(v, 64)
			gotLRA = err == nil
		}
	}
	if !gotI || !gotLRA {
		return 0, 0, errors.New("没有 lavfi.r128.I 与 lavfi.r128.LRA")
	}
	return integrated, lra, nil
}

// Blank 判一张图是不是空白（纯函数）：亮度的标准差小于 2（全黑、全白、纯色，含编码噪声）。
func Blank(img image.Image) bool {
	b := img.Bounds()
	var n, sum, sum2 float64
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, g, bl, _ := img.At(x, y).RGBA()
			l := (0.299*float64(r) + 0.587*float64(g) + 0.114*float64(bl)) / 257
			n, sum, sum2 = n+1, sum+l, sum2+l*l
		}
	}
	if n == 0 {
		return true
	}
	mean := sum / n
	return math.Sqrt(math.Max(sum2/n-mean*mean, 0)) < 2
}

// video：取 out/ 里最近渲染的成片，运行时自己用 ffprobe 读时长、分辨率，ffmpeg ebur128 读响度，
// 导出第一帧（不能是空白）并抽 9 帧拼联系表。
func video(ctx context.Context, e Env) (Result, error) {
	var files []fs.FileInfo
	entries, err := os.ReadDir(filepath.Join(e.Dir, renderDir))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return Result{}, err
	}
	for _, d := range entries {
		fi, err := d.Info()
		if err != nil {
			return Result{}, err
		}
		files = append(files, fi)
	}
	name := Newest(files)
	if name == "" {
		return Result{Evidence: fmt.Sprintf("%s/ 里没有渲染出的成片（%s）", renderDir, strings.Join(videoExts, "、"))}, nil
	}
	file := filepath.Join(e.Dir, renderDir, name)
	rel := renderDir + "/" + name

	out, err := e.R.Run(ctx, e.Dir, "ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", file)
	if err != nil {
		why, err := failed(ctx, "ffprobe 读 "+rel+" ", err)
		return Result{Evidence: why}, err
	}
	m, err := ParseProbe(out)
	if err != nil {
		return Result{Evidence: fmt.Sprintf("ffprobe 读 %s：%v", rel, err)}, nil
	}

	first := filepath.Join(e.Out, "video-first-frame.png")
	if _, err := e.R.Run(ctx, e.Dir, "ffmpeg", "-v", "error", "-y", "-i", file, "-frames:v", "1", first); err != nil {
		why, err := failed(ctx, "导出第一帧", err)
		return Result{Evidence: why}, err
	}
	blank, err := blankFile(first)
	if err != nil {
		return Result{}, err
	}
	if blank {
		return Result{Evidence: rel + " 的第一帧是空白", Artifacts: []string{first}}, nil
	}

	sheet := filepath.Join(e.Out, "video-contact-sheet.png")
	vf := fmt.Sprintf("fps=9/%.3f,scale=320:-1,tile=3x3", m.Duration)
	if _, err := e.R.Run(ctx, e.Dir, "ffmpeg", "-v", "error", "-y", "-i", file, "-vf", vf, "-frames:v", "1", sheet); err != nil {
		why, err := failed(ctx, "拼联系表", err)
		return Result{Evidence: why, Artifacts: []string{first}}, err
	}

	return Result{OK: true, Evidence: fmt.Sprintf("%s：时长 %.1f 秒，%dx%d，%s", rel, m.Duration, m.Width, m.Height, loudness(ctx, e, file, m.Audio)),
		Artifacts: []string{first, sheet}}, nil
}

// loudness 读响度，给一句人话：没有音轨、读出的数，或读取失败的原因（只记给负责人看，不判过不过）。
func loudness(ctx context.Context, e Env, file string, audio bool) string {
	if !audio {
		return "没有音轨"
	}
	// ebur128 的汇总只打到标准错误；改让 ametadata 把逐帧结果写进任务目录的文件（相对路径，免得滤镜参数里转义盘符）。
	const name = "loudness.txt"
	_, err := e.R.Run(ctx, e.Out, "ffmpeg", "-v", "error", "-nostats", "-i", file, "-vn",
		"-af", "ebur128=metadata=1,ametadata=mode=print:file="+name, "-f", "null", "-")
	if err != nil {
		return fmt.Sprintf("响度读取失败：%v", err)
	}
	raw, err := os.ReadFile(filepath.Join(e.Out, name))
	if err != nil {
		return fmt.Sprintf("响度读取失败：%v", err)
	}
	i, lra, err := ParseLoudness(string(raw))
	if err != nil {
		return fmt.Sprintf("响度读取失败：%v", err)
	}
	return fmt.Sprintf("响度 %.1f LUFS（LRA %.1f LU）", i, lra)
}
