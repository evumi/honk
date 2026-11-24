package honk

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

// ParseKey decodes the bot key the app shows in the bot's settings: 32 bytes
// of base64, standard or URL alphabet, padded or not.
func ParseKey(s string) ([]byte, error) {
	s = strings.TrimRight(strings.TrimSpace(s), "=")
	s = strings.NewReplacer("+", "-", "/", "_").Replace(s)
	k, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, errors.New("key is not base64")
	}
	if len(k) != 32 {
		return nil, fmt.Errorf("key must be 32 bytes, got %d", len(k))
	}
	return k, nil
}

// Seal encrypts plaintext the way Honk's apps open it: AES-256-GCM with aad
// (the bot's short id) authenticated, written as the unpadded base64url text
// of nonce(12) || ciphertext || tag(16). Send and Edit call it for you.
func Seal(key []byte, aad string, plaintext []byte) (string, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(gcm.Seal(nonce, nonce, plaintext, []byte(aad))), nil
}

// Open reverses Seal.
func Open(key []byte, aad, text string) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(text, "="))
	if err != nil {
		return nil, errors.New("ciphertext is not base64url")
	}
	if len(raw) < gcm.NonceSize()+gcm.Overhead() {
		return nil, errors.New("ciphertext is too short")
	}
	return gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], []byte(aad))
}

func newGCM(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("key must be 32 bytes, got %d", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
