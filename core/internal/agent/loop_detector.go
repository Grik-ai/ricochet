package agent

import (
	"crypto/md5"
	"fmt"
	"strings"
	"sync"
)

// LoopDetector detects repetitive content patterns that indicate agent is stuck
type LoopDetector struct {
	mu             sync.Mutex
	toolSignatures    []string // circular buffer of "ToolName:ArgsHash"
	errorOutputs      []string // circular buffer of error messages
	contentSignatures []string // circular buffer of textual content hashes
	threshold         int      // max repetitions allowed
	bufferSize        int
}

// NewLoopDetector creates a detector with given repetition threshold
func NewLoopDetector(threshold int) *LoopDetector {
	return &LoopDetector{
		threshold:         threshold,
		toolSignatures:    make([]string, 0, 5), // Window of 5
		errorOutputs:      make([]string, 0, 5), // Window of 5
		contentSignatures: make([]string, 0, 5), // Window of 5
		bufferSize:        5,
	}
}

// CheckTool checks for repetitive tool usage (Rule A)
func (d *LoopDetector) CheckTool(name string, args string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	// Create a stable signature: Name + MD5(Args)
	// We hash args to avoid storing huge JSON strings
	argsHash := fmt.Sprintf("%x", md5.Sum([]byte(args)))
	sig := fmt.Sprintf("%s:%s", name, argsHash)

	// Add to buffer
	if len(d.toolSignatures) >= d.bufferSize {
		d.toolSignatures = d.toolSignatures[1:]
	}
	d.toolSignatures = append(d.toolSignatures, sig)

	// Check for 3 consecutive repetitions
	if len(d.toolSignatures) >= 3 {
		last := d.toolSignatures[len(d.toolSignatures)-1]
		count := 0
		// Check the last 3 entries
		for i := len(d.toolSignatures) - 1; i >= len(d.toolSignatures)-3; i-- {
			if d.toolSignatures[i] == last {
				count++
			}
		}

		if count >= 3 {
			return fmt.Errorf("loop detected: tool '%s' with identical arguments called 3 times in a row. STOP RETRYING. Proceed to the next step or change strategy.", name)
		}
	}

	return nil
}

// CheckError checks for repetitive errors (Rule B)
func (d *LoopDetector) CheckError(output string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	// Only track if it looks like an error (simple heuristic or caller indicates it)
	// However, the caller usually knows if it's an error result.
	// For this method, we assume the caller ONLY calls it for error outputs.

	// Hash the error to save space/comparison time
	errHash := fmt.Sprintf("%x", md5.Sum([]byte(output)))

	// Add to buffer
	if len(d.errorOutputs) >= d.bufferSize {
		d.errorOutputs = d.errorOutputs[1:]
	}
	d.errorOutputs = append(d.errorOutputs, errHash)

	// Check for 3 consecutive repetitions
	if len(d.errorOutputs) >= 3 {
		last := d.errorOutputs[len(d.errorOutputs)-1]
		count := 0
		for i := len(d.errorOutputs) - 1; i >= len(d.errorOutputs)-3; i-- {
			if d.errorOutputs[i] == last {
				count++
			}
		}

		if count >= 3 {
			return fmt.Errorf("stuck detected: identical error received 3 times in a row")
		}
	}

	return nil
}

// CheckContent checks for repetitive textual responses (Rule C)
func (d *LoopDetector) CheckContent(content string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	// Trim and hash to normalize comparison
	clean := strings.TrimSpace(content)
	if len(clean) < 10 {
		return nil // Ignore very short phrases (e.g. "Yes", "Ok")
	}

	hash := fmt.Sprintf("%x", md5.Sum([]byte(clean)))

	// Add to buffer
	if len(d.contentSignatures) >= d.bufferSize {
		d.contentSignatures = d.contentSignatures[1:]
	}
	d.contentSignatures = append(d.contentSignatures, hash)

	// Check for 3 consecutive repetitions
	if len(d.contentSignatures) >= 3 {
		last := d.contentSignatures[len(d.contentSignatures)-1]
		count := 0
		for i := len(d.contentSignatures) - 1; i >= len(d.contentSignatures)-3; i-- {
			if d.contentSignatures[i] == last {
				count++
			}
		}

		if count >= 3 {
			return fmt.Errorf("loop detected: you have repeated the same textual response 3 times. Please summarize progress and change approach.")
		}
	}

	return nil
}

// Reset clears state
func (d *LoopDetector) Reset() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.toolSignatures = make([]string, 0, d.bufferSize)
	d.errorOutputs = make([]string, 0, d.bufferSize)
	d.contentSignatures = make([]string, 0, d.bufferSize)
}
