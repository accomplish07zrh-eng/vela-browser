// Copyright 2026 Vela Browser contributors. SPDX-License-Identifier: BSD-2-Clause
#pragma once

#include <charconv>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string_view>

// Disabled in stock WebKit. A custom runtime inherits exactly one saved seed
// in every child process; no clock, origin, process id or device enters it.
namespace WebCore::VelaFingerprint {

inline uint32_t seed()
{
    static const uint32_t value = [] {
#if defined(_WIN32)
        char storage[11] { };
        size_t size = 0;
        if (getenv_s(&size, storage, sizeof(storage), "VELA_WEBKIT_FINGERPRINT_SEED") || !size)
            return uint32_t { 0 };
        const char* text = storage;
#else
        const char* text = std::getenv("VELA_WEBKIT_FINGERPRINT_SEED");
#endif
        if (!text)
            return uint32_t { 0 };
        uint32_t parsed = 0;
        const auto length = std::strlen(text);
        const auto result = std::from_chars(text, text + length, parsed);
        if (result.ec != std::errc { } || result.ptr != text + length || !parsed)
            return uint32_t { 0 };
        return parsed;
    }();
    return value;
}

inline uint64_t bits(std::string_view domain)
{
    uint64_t value = uint64_t { seed() } ^ 0x56454c412d574b31ULL;
    for (unsigned char byte : domain) {
        // Font family aliases must resolve to the same native face and salt.
        if (byte >= 'A' && byte <= 'Z')
            byte += 'a' - 'A';
        value = (value ^ byte) * 0x100000001b3ULL;
    }
    value = (value ^ (value >> 30)) * 0xbf58476d1ce4e5b9ULL;
    value = (value ^ (value >> 27)) * 0x94d049bb133111ebULL;
    return value ^ (value >> 31);
}

inline float fontScale(std::string_view nativeFamily)
{
    if (!seed())
        return 1.0f;
    const auto value = bits(nativeFamily);
    const float delta = 0.001f + float(value % 3001) * 0.000001f;
    return (value >> 63) ? 1.0f + delta : 1.0f - delta;
}

} // namespace WebCore::VelaFingerprint
