package com.attendx.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Green = Color(0xFF10B981)
val GreenPale = Color(0xFFE5F6F0)
val Ink = Color(0xFF13201C)
val DarkBg = Color(0xFF0B1311)
val DarkSurface = Color(0xFF14201C)
val Muted = Color(0xFF6B7A76)

private val LightColors = lightColorScheme(
    primary = Green,
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = GreenPale,
    onPrimaryContainer = Ink,
    secondary = Color(0xFF1F5C49),
    background = Color(0xFFF4F7F5),
    surface = Color(0xFFFFFFFF),
    onSurface = Ink,
    onBackground = Ink,
    outline = Color(0xFFD5DEDA),
)

private val DarkColors = darkColorScheme(
    primary = Green,
    onPrimary = Color(0xFF04110D),
    primaryContainer = Color(0xFF15302A),
    onPrimaryContainer = Color(0xFFBDF3E0),
    secondary = Color(0xFF9EDCC4),
    background = DarkBg,
    surface = DarkSurface,
    onSurface = Color(0xFFE4ECEA),
    onBackground = Color(0xFFE4ECEA),
    outline = Color(0xFF2A3A35),
)

@Composable
fun AttendXTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        content = content
    )
}