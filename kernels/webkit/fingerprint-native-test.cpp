// Copyright 2026 Vela Browser contributors. SPDX-License-Identifier: BSD-2-Clause
#include "VelaFingerprint.h"
#include <cassert>
#include <cmath>
#include <iostream>
#include <string>

int main(int argc, char** argv)
{
    using namespace WebCore::VelaFingerprint;
    assert(argc == 2);
    const auto expected = static_cast<uint32_t>(std::stoul(argv[1]));
    assert(seed() == expected);
    assert(bits("Arial") == bits("ARIAL"));
    assert(bits("canvas/v1") != bits("Arial"));
    assert(std::isfinite(fontScale("Arial")));
    if (!seed()) {
        assert(fontScale("Arial") == 1.0f);
    } else {
        assert(fontScale("Arial") != 1.0f);
        for (const auto* family : { "Arial", "Times New Roman", "Consolas", "Microsoft YaHei" }) {
            const auto scale = fontScale(family);
            assert(std::abs(scale - 1.0f) <= 0.004001f);
            for (int repeat = 0; repeat < 100; ++repeat)
                assert(scale == fontScale(family));
        }
    }
    std::cout << seed() << ':' << bits("canvas/v1") << ':' << fontScale("Arial") << '\n';
}
