// JNI for dev.evumi.honk.core.CardNative (android/core). Strings cross as
// UTF-8 byte arrays: JNI's own string functions use modified UTF-8, which
// QuickJS does not read.

#include <jni.h>
#include <stdlib.h>
#include <string.h>

#include "honk_card.h"

/** A NUL-terminated copy of a Java byte[]. */
static char *bytes(JNIEnv *env, jbyteArray a) {
    if (!a) return NULL;
    jsize n = (*env)->GetArrayLength(env, a);
    char *s = malloc((size_t)n + 1);
    if (!s) return NULL;
    (*env)->GetByteArrayRegion(env, a, 0, n, (jbyte *)s);
    s[n] = 0;
    return s;
}

/** A Java byte[] of a result, which it frees. */
static jbyteArray result(JNIEnv *env, char *r) {
    if (!r) return NULL;
    jsize n = (jsize)strlen(r);
    jbyteArray a = (*env)->NewByteArray(env, n);
    if (a) (*env)->SetByteArrayRegion(env, a, 0, n, (const jbyte *)r);
    honk_card_free_string(r);
    return a;
}

#define CARD(h) ((HonkCard *)(intptr_t)(h))

JNIEXPORT jlong JNICALL Java_dev_evumi_honk_core_CardNative_open(JNIEnv *env, jclass cls, jbyteArray load, jobjectArray out) {
    char *l = bytes(env, load);
    if (!l) return 0;
    char *r = NULL;
    HonkCard *c = honk_card_open(l, NULL, &r);
    free(l);
    (*env)->SetObjectArrayElement(env, out, 0, result(env, r));
    return (jlong)(intptr_t)c;
}

JNIEXPORT jbyteArray JNICALL Java_dev_evumi_honk_core_CardNative_click(JNIEnv *env, jclass cls, jlong h, jbyteArray path) {
    char *p = bytes(env, path);
    if (!p) return NULL;
    jbyteArray a = result(env, honk_card_click(CARD(h), p));
    free(p);
    return a;
}

JNIEXPORT jbyteArray JNICALL Java_dev_evumi_honk_core_CardNative_tick(JNIEnv *env, jclass cls, jlong h) {
    return result(env, honk_card_tick(CARD(h)));
}

JNIEXPORT jbyteArray JNICALL Java_dev_evumi_honk_core_CardNative_set(JNIEnv *env, jclass cls, jlong h, jbyteArray state) {
    char *s = bytes(env, state);
    if (!s) return NULL;
    jbyteArray a = result(env, honk_card_set(CARD(h), s));
    free(s);
    return a;
}

JNIEXPORT jdouble JNICALL Java_dev_evumi_honk_core_CardNative_next(JNIEnv *env, jclass cls, jlong h) {
    return honk_card_next(CARD(h));
}

JNIEXPORT void JNICALL Java_dev_evumi_honk_core_CardNative_close(JNIEnv *env, jclass cls, jlong h) {
    honk_card_close(CARD(h));
}
