package gates

import (
	"encoding/json"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// VideoMeta 是 ffprobe 读出的视频基本元数据。
type VideoMeta struct {
	Width    int     `json:"width"`
	Height   int     `json:"height"`
	Duration float64 `json:"duration"`
}

// LoudnessMeta 是 ffmpeg ebur128 解析出的响度信息。
type LoudnessMeta struct {
	Integrated float64 `json:"integrated"` // LUFS
	LRA        float64 `json:"lra"`        // LU
	Parsed     bool    `json:"parsed"`
}

var (
	reIntegrated = regexp.MustCompile(`(?i)Integrated\s+loudness:\s*I:\s*([-\d.]+)\s*LUFS`)
	reLRA        = regexp.MustCompile(`(?i)Loudness\s+range:\s*LRA:\s*([-\d.]+)\s*LU`)
)

// FindVideoFile 在工作目录中查找视频文件（.mp4、.mov、.webm、.mkv）。
func FindVideoFile(workDir string) (string, error) {
	priorityDirs := []string{
		filepath.Join(workDir, "out"),
		filepath.Join(workDir, "render"),
		filepath.Join(workDir, "build"),
		filepath.Join(workDir, "public"),
		workDir,
	}

	exts := map[string]bool{
		".mp4":  true,
		".mov":  true,
		".webm": true,
		".mkv":  true,
	}

	for _, dir := range priorityDirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() && exts[strings.ToLower(filepath.Ext(e.Name()))] {
				return filepath.Join(dir, e.Name()), nil
			}
		}
	}

	var found string
	_ = filepath.WalkDir(workDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && (d.Name() == "node_modules" || d.Name() == ".git") {
			return filepath.SkipDir
		}
		if !d.IsDir() && exts[strings.ToLower(filepath.Ext(d.Name()))] {
			found = path
			return fs.SkipAll
		}
		return nil
	})

	if found != "" {
		return found, nil
	}
	return "", fmt.Errorf("找不到视频文件（.mp4、.mov、.webm）")
}

type ffprobeOutput struct {
	Streams []struct {
		Width    int    `json:"width"`
		Height   int    `json:"height"`
		Duration string `json:"duration"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

// ParseFFprobe 纯解析：从 ffprobe 的 JSON 输出中解析出视频宽高与时长。
func ParseFFprobe(data []byte) (VideoMeta, error) {
	var raw ffprobeOutput
	if err := json.Unmarshal(data, &raw); err != nil {
		return VideoMeta{}, fmt.Errorf("解析 ffprobe 输出失败：%w", err)
	}

	var meta VideoMeta
	for _, s := range raw.Streams {
		if s.Width > 0 && s.Height > 0 {
			meta.Width = s.Width
			meta.Height = s.Height
			if s.Duration != "" && s.Duration != "N/A" {
				if d, err := strconv.ParseFloat(s.Duration, 64); err == nil && d > 0 {
					meta.Duration = d
				}
			}
			break
		}
	}

	if meta.Duration <= 0 && raw.Format.Duration != "" && raw.Format.Duration != "N/A" {
		if d, err := strconv.ParseFloat(raw.Format.Duration, 64); err == nil && d > 0 {
			meta.Duration = d
		}
	}

	if meta.Width <= 0 || meta.Height <= 0 {
		return meta, fmt.Errorf("未找到有效的视频流分辨率")
	}
	if meta.Duration <= 0 {
		return meta, fmt.Errorf("未读取到有效视频时长")
	}

	return meta, nil
}

// ParseEbur128 纯解析：从 ffmpeg ebur128 输出中提取综合响度与响度范围。
func ParseEbur128(output string) (LoudnessMeta, error) {
	mI := reIntegrated.FindStringSubmatch(output)
	mLRA := reLRA.FindStringSubmatch(output)

	if mI == nil {
		return LoudnessMeta{}, fmt.Errorf("未能从 ebur128 输出中找到综合响度 (I)")
	}

	iVal, err := strconv.ParseFloat(mI[1], 64)
	if err != nil {
		return LoudnessMeta{}, fmt.Errorf("解析综合响度失败：%w", err)
	}

	var lraVal float64
	if mLRA != nil {
		lraVal, _ = strconv.ParseFloat(mLRA[1], 64)
	}

	return LoudnessMeta{
		Integrated: iVal,
		LRA:        lraVal,
		Parsed:     true,
	}, nil
}

// IsBlankImage 纯判定：检查图片是否为空白（全黑、全白、纯色平涂或极低方差）。
func IsBlankImage(img image.Image) bool {
	bounds := img.Bounds()
	if bounds.Empty() || bounds.Dx() == 0 || bounds.Dy() == 0 {
		return true
	}

	var (
		minY  = 255.0
		maxY  = 0.0
		sumY  = 0.0
		sumY2 = 0.0
		count = 0.0
	)

	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			r, g, b, a := img.At(x, y).RGBA()
			if a == 0 {
				continue
			}
			rf := float64(r >> 8)
			gf := float64(g >> 8)
			bf := float64(b >> 8)
			lum := 0.299*rf + 0.587*gf + 0.114*bf
			if lum < minY {
				minY = lum
			}
			if lum > maxY {
				maxY = lum
			}
			sumY += lum
			sumY2 += lum * lum
			count++
		}
	}

	if count == 0 {
		return true
	}

	if maxY-minY <= 2.0 {
		return true
	}

	mean := sumY / count
	variance := (sumY2 / count) - (mean * mean)
	return variance < 1.0
}

// checkVideoProbe 运行 ffprobe 读时长、分辨率，并用 ffmpeg ebur128 读响度。
func checkVideoProbe(c CheckContext) (CheckResult, error) {
	videoFile, err := FindVideoFile(c.WorkDir)
	if err != nil {
		return CheckResult{Check: "video_probe", OK: false, Evidence: err.Error()}, nil
	}

	out, err := c.Runner.Run(c.Context, c.WorkDir, "ffprobe",
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "stream=width,height,duration",
		"-show_entries", "format=duration",
		"-of", "json",
		videoFile,
	)
	if err != nil {
		return CheckResult{Check: "video_probe", OK: false, Evidence: fmt.Sprintf("ffprobe 读取视频流失败：%v", err)}, nil
	}

	meta, err := ParseFFprobe([]byte(out))
	if err != nil {
		return CheckResult{Check: "video_probe", OK: false, Evidence: err.Error()}, nil
	}

	// 检查音频流并读取响度
	loudnessStr := "无音频流"
	audioOut, err := c.Runner.Run(c.Context, c.WorkDir, "ffprobe",
		"-v", "error",
		"-select_streams", "a:0",
		"-show_entries", "stream=index",
		"-of", "json",
		videoFile,
	)
	hasAudio := false
	if err == nil && strings.Contains(audioOut, `"index"`) {
		hasAudio = true
	}

	if hasAudio {
		eburOut, err := c.Runner.Run(c.Context, c.WorkDir, "ffmpeg",
			"-nostats",
			"-i", videoFile,
			"-filter_complex", "ebur128",
			"-f", "null",
			"-",
		)
		if err == nil {
			if lmeta, lerr := ParseEbur128(eburOut); lerr == nil && lmeta.Parsed {
				loudnessStr = fmt.Sprintf("%.1f LUFS（LRA %.1f LU）", lmeta.Integrated, lmeta.LRA)
			}
		}
	}

	evidence := fmt.Sprintf("视频信息：时长 %.1fs，分辨率 %dx%d，响度 %s", meta.Duration, meta.Width, meta.Height, loudnessStr)
	return CheckResult{
		Check:    "video_probe",
		OK:       true,
		Evidence: evidence,
	}, nil
}

// checkVideoFrames 导出第一帧并检查非空白，抽帧拼联系表。
func checkVideoFrames(c CheckContext) (CheckResult, error) {
	videoFile, err := FindVideoFile(c.WorkDir)
	if err != nil {
		return CheckResult{Check: "video_frames", OK: false, Evidence: err.Error()}, nil
	}

	firstFramePath := filepath.Join(c.TaskDir, "video-first-frame.png")
	contactSheetPath := filepath.Join(c.TaskDir, "video-contact-sheet.png")

	// 1. 导出第一帧
	if _, err := c.Runner.Run(c.Context, c.WorkDir, "ffmpeg",
		"-y",
		"-i", videoFile,
		"-vframes", "1",
		"-update", "1",
		firstFramePath,
	); err != nil {
		return CheckResult{Check: "video_frames", OK: false, Evidence: fmt.Sprintf("导出第一帧失败：%v", err)}, nil
	}

	// 检查第一帧是否为空白
	file, err := os.Open(firstFramePath)
	if err != nil {
		return CheckResult{Check: "video_frames", OK: false, Evidence: fmt.Sprintf("读取第一帧图片失败：%v", err)}, nil
	}
	img, _, decodeErr := image.Decode(file)
	_ = file.Close()
	if decodeErr != nil {
		return CheckResult{Check: "video_frames", OK: false, Evidence: fmt.Sprintf("解码第一帧图片失败：%v", decodeErr)}, nil
	}

	if IsBlankImage(img) {
		return CheckResult{
			Check:     "video_frames",
			OK:        false,
			Evidence:  fmt.Sprintf("第一帧为空白图片（已保存至 %s）", firstFramePath),
			Artifacts: []string{firstFramePath},
		}, nil
	}

	// 2. 抽帧拼联系表（3x3 瓦片）
	// 先查时长
	duration := 1.0
	out, err := c.Runner.Run(c.Context, c.WorkDir, "ffprobe",
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "format=duration",
		"-of", "json",
		videoFile,
	)
	if err == nil {
		if meta, perr := ParseFFprobe([]byte(out)); perr == nil && meta.Duration > 0 {
			duration = meta.Duration
		}
	}

	fps := 9.0 / duration
	if fps <= 0 || math.IsNaN(fps) || math.IsInf(fps, 0) {
		fps = 1.0
	}

	vf := fmt.Sprintf("fps=%.4f,scale=320:-1,tile=3x3", fps)
	if _, err := c.Runner.Run(c.Context, c.WorkDir, "ffmpeg",
		"-y",
		"-i", videoFile,
		"-vf", vf,
		"-frames:v", "1",
		"-update", "1",
		contactSheetPath,
	); err != nil {
		return CheckResult{
			Check:     "video_frames",
			OK:        false,
			Evidence:  fmt.Sprintf("生成联系表失败：%v", err),
			Artifacts: []string{firstFramePath},
		}, nil
	}

	artifacts := []string{firstFramePath, contactSheetPath}
	evidence := fmt.Sprintf("第一帧与联系表已生成：%s、%s", firstFramePath, contactSheetPath)
	return CheckResult{
		Check:     "video_frames",
		OK:        true,
		Evidence:  evidence,
		Artifacts: artifacts,
	}, nil
}

// checkVideo 复合检查：元数据探测与帧检查。
func checkVideo(c CheckContext) (CheckResult, error) {
	probeRes, err := checkVideoProbe(c)
	if err != nil {
		return CheckResult{Check: "video"}, err
	}
	if !probeRes.OK {
		return CheckResult{Check: "video", OK: false, Evidence: probeRes.Evidence}, nil
	}

	frameRes, err := checkVideoFrames(c)
	if err != nil {
		return CheckResult{Check: "video"}, err
	}
	if !frameRes.OK {
		return CheckResult{Check: "video", OK: false, Evidence: frameRes.Evidence, Artifacts: frameRes.Artifacts}, nil
	}

	return CheckResult{
		Check:     "video",
		OK:        true,
		Evidence:  fmt.Sprintf("%s；%s", probeRes.Evidence, frameRes.Evidence),
		Artifacts: frameRes.Artifacts,
	}, nil
}
