/* Minimal libretro frontend for the Rebit WASM feasibility proof. GPL-2.0-or-later. */
#include <emscripten/emscripten.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../../libretro/libretro.h"

static const struct retro_core_option_v2_definition *options;
static struct retro_keyboard_callback keyboard;
static struct retro_disk_control_ext_callback disks;
static struct retro_system_av_info av;
static uint32_t *pixels;
static unsigned width, height, capacity, frame;
static uint8_t keys[512];
static int16_t samples[16384];
static unsigned sample_frames;
static uint64_t nonzero_samples;
static void *content;
static void *state;
static size_t state_size;
static uint16_t pad;
static unsigned machine, mono;

static void logger(enum retro_log_level level, const char *format, ...)
{
    if (level < RETRO_LOG_WARN) return;
    va_list args;
    va_start(args, format);
    vfprintf(stderr, format, args);
    va_end(args);
}

static bool environment(unsigned cmd, void *data)
{
    switch (cmd) {
    case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
        ((struct retro_log_callback *)data)->log = logger; return true;
    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
        *(const char **)data = "/system"; return true;
    case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
        *(const char **)data = "/saves"; return true;
    case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION:
        *(unsigned *)data = 2; return true;
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2:
        options = ((struct retro_core_options_v2 *)data)->definitions; return true;
    case RETRO_ENVIRONMENT_GET_VARIABLE: {
        struct retro_variable *v = data;
        if (!strcmp(v->key, "hatarib_machine")) v->value = machine == 2 ? "2" : "0";
        else if (!strcmp(v->key, "hatarib_monitor")) v->value = mono ? "0" : "1";
        else if (!strcmp(v->key, "hatarib_emutos_framerate")) v->value = "1";
        else if (!strcmp(v->key, "hatarib_tos")) v->value = "<etos1024k>";
        else {
            v->value = NULL;
            if (options) for (const struct retro_core_option_v2_definition *o = options; o->key; ++o)
                if (!strcmp(v->key, o->key)) { v->value = o->default_value; break; }
        }
        return v->value != NULL;
    }
    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
        *(bool *)data = false; return true;
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
        return *(enum retro_pixel_format *)data == RETRO_PIXEL_FORMAT_XRGB8888;
    case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
        av = *(struct retro_system_av_info *)data; return true;
    case RETRO_ENVIRONMENT_SET_GEOMETRY:
        av.geometry = *(struct retro_game_geometry *)data; return true;
    case RETRO_ENVIRONMENT_SET_KEYBOARD_CALLBACK:
        keyboard = *(struct retro_keyboard_callback *)data; return true;
    case RETRO_ENVIRONMENT_GET_DISK_CONTROL_INTERFACE_VERSION:
        *(unsigned *)data = 1; return true;
    case RETRO_ENVIRONMENT_SET_DISK_CONTROL_EXT_INTERFACE:
        disks = *(struct retro_disk_control_ext_callback *)data; return true;
    case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
        return true;
    case RETRO_ENVIRONMENT_GET_CAN_DUPE:
        *(bool *)data = true; return true;
    case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
    case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
    case RETRO_ENVIRONMENT_SET_CONTENT_INFO_OVERRIDE:
    case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME:
    case RETRO_ENVIRONMENT_SET_SERIALIZATION_QUIRKS:
    case RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS:
    case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
        return true;
    default: return false;
    }
}

static void video(const void *data, unsigned w, unsigned h, size_t pitch)
{
    if (!data) return;
    if (!w || !h || w > 2048 || h > 2048) abort();
    if (w * h > capacity) {
        capacity = w * h;
        free(pixels);
        pixels = malloc(capacity * sizeof(*pixels));
        if (!pixels) abort();
    }
    width = w; height = h;
    for (unsigned y = 0; y < h; ++y) {
        const uint32_t *src = (const uint32_t *)((const uint8_t *)data + y * pitch);
        for (unsigned x = 0; x < w; ++x) {
            uint32_t p = src[x];
            pixels[y*w+x] = 0xff000000 | ((p >> 16) & 255) | (p & 0xff00) | ((p & 255) << 16);
        }
    }
}

static size_t audio_batch(const int16_t *data, size_t count)
{
    if ((sample_frames + count) * 2 > sizeof(samples) / sizeof(samples[0])) abort();
    memcpy(samples + sample_frames * 2, data, count * 2 * sizeof(int16_t));
    for (size_t i = 0; i < count * 2; ++i) nonzero_samples += data[i] != 0;
    sample_frames += count;
    return count;
}
static void audio_sample(int16_t left, int16_t right) { const int16_t pair[] = {left, right}; audio_batch(pair, 1); }
static void poll(void) {}
static int16_t input(unsigned port, unsigned device, unsigned index, unsigned id)
{
    if (device == RETRO_DEVICE_KEYBOARD) return id < sizeof(keys) ? keys[id] : 0;
    if (port == 0 && device == RETRO_DEVICE_JOYPAD)
        return id == RETRO_DEVICE_ID_JOYPAD_MASK ? pad : (id < 16 ? (pad >> id) & 1 : 0);
    return 0;
}

EMSCRIPTEN_KEEPALIVE int proof_init(const char *path, unsigned machine_type, unsigned monochrome)
{
    machine = machine_type; mono = monochrome;
    retro_set_environment(environment);
    retro_set_video_refresh(video);
    retro_set_audio_sample(audio_sample);
    retro_set_audio_sample_batch(audio_batch);
    retro_set_input_poll(poll);
    retro_set_input_state(input);
    retro_init();
    FILE *file = path ? fopen(path, "rb") : NULL;
    if (path && !file) return 0;
    struct retro_game_info game = {0};
    if (file) {
        fseek(file, 0, SEEK_END); game.size = ftell(file); rewind(file);
        content = malloc(game.size);
        if (!content || fread(content, 1, game.size, file) != game.size) abort();
        fclose(file); game.path = path; game.data = content;
    }
    if (!retro_load_game(path ? &game : NULL)) return 0;
    retro_get_system_av_info(&av);
    state_size = retro_serialize_size();
    state = malloc(state_size);
    return state != NULL;
}
EMSCRIPTEN_KEEPALIVE void proof_run(void) { sample_frames = 0; retro_run(); ++frame; }
EMSCRIPTEN_KEEPALIVE void proof_key(unsigned key, unsigned down)
{
    if (key >= sizeof(keys)) return;
    keys[key] = !!down;
    if (keyboard.callback) keyboard.callback(!!down, key, key >= 32 && key < 127 ? key : 0, 0);
}
EMSCRIPTEN_KEEPALIVE void proof_pad(unsigned value) { pad = value; }
EMSCRIPTEN_KEEPALIVE unsigned proof_width(void) { return width; }
EMSCRIPTEN_KEEPALIVE unsigned proof_height(void) { return height; }
EMSCRIPTEN_KEEPALIVE void *proof_pixels(void) { return pixels; }
EMSCRIPTEN_KEEPALIVE unsigned proof_frame(void) { return frame; }
EMSCRIPTEN_KEEPALIVE double proof_fps(void) { return av.timing.fps; }
EMSCRIPTEN_KEEPALIVE double proof_sample_rate(void) { return av.timing.sample_rate; }
EMSCRIPTEN_KEEPALIVE unsigned proof_audio_frames(void) { return sample_frames; }
EMSCRIPTEN_KEEPALIVE void *proof_audio(void) { return samples; }
EMSCRIPTEN_KEEPALIVE double proof_audio_nonzero(void) { return nonzero_samples; }
EMSCRIPTEN_KEEPALIVE unsigned proof_state_size(void) { return state_size; }
EMSCRIPTEN_KEEPALIVE void *proof_state(void) { return state; }
EMSCRIPTEN_KEEPALIVE int proof_save(void) { memset(state, 0, state_size); return retro_serialize(state, state_size); }
EMSCRIPTEN_KEEPALIVE int proof_load(void) { return retro_unserialize(state, state_size); }
EMSCRIPTEN_KEEPALIVE unsigned proof_disk_count(void) { return disks.get_num_images ? disks.get_num_images() : 0; }
EMSCRIPTEN_KEEPALIVE int proof_disk(unsigned index)
{
    return disks.set_eject_state && disks.set_eject_state(true) && disks.set_image_index(index) && disks.set_eject_state(false);
}
EMSCRIPTEN_KEEPALIVE void proof_destroy(void)
{
    retro_unload_game(); retro_deinit(); free(content); free(state); free(pixels);
    content = state = pixels = NULL;
}
