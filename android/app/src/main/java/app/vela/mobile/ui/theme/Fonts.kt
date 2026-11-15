package app.vela.mobile.ui.theme

import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import app.vela.mobile.R

/** The "Vela" wordmark: Playfair Display bold italic (OFL), Latin letters only. */
val WordmarkFont = FontFamily(Font(R.font.playfair_bold_italic, FontWeight.Bold, FontStyle.Italic))

/**
 * Titles and empty states: Noto Serif SC Bold (OFL), the desktop's section-title face, cut down to
 * the characters this app uses (android/tools/subset_fonts.py).
 */
val TitleSerif = FontFamily(Font(R.font.noto_serif_sc_bold, FontWeight.Bold))
