package com.attendx.app.ui

import android.content.Context
import android.graphics.Bitmap
import android.location.Location
import android.location.LocationManager
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.attendx.app.api.Api
import com.attendx.app.api.Session
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.MultiFormatWriter
import com.google.zxing.common.BitMatrix
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray

private fun lastLocation(context: Context): Location? {
    val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    val provider = if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) LocationManager.GPS_PROVIDER else LocationManager.NETWORK_PROVIDER
    return try { lm.getLastKnownLocation(provider) } catch (_: Exception) { null }
}

private fun qrBitmap(text: String, size: Int = 512): androidx.compose.ui.graphics.ImageBitmap {
    val hints = mapOf(EncodeHintType.MARGIN to 1)
    val matrix: BitMatrix = MultiFormatWriter().encode(text, BarcodeFormat.QR_CODE, size, size, hints)
    val pixels = IntArray(size * size)
    for (y in 0 until size) for (x in 0 until size) {
        pixels[y * size + x] = if (matrix[x, y]) 0xFF0B1311.toInt() else 0xFFFFFFFF.toInt()
    }
    return Bitmap.createBitmap(pixels, size, size, Bitmap.Config.ARGB_8888).asImageBitmap()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionScreen(api: Api, session: Session, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var classes by remember { mutableStateOf<JSONArray>(JSONArray()) }
    var selectedClass by remember { mutableStateOf("") }
    var classExpanded by remember { mutableStateOf(false) }
    var loadingClasses by remember { mutableStateOf(true) }

    var sessionId by remember { mutableStateOf<String?>(null) }
    var qrText by remember { mutableStateOf<String?>(null) }
    var roster by remember { mutableStateOf<JSONArray>(JSONArray()) }
    var starting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        classes = api.classes(session.userId)
        loadingClasses = false
    }

    fun start() {
        scope.launch {
            starting = true; error = null
            try {
                val loc = lastLocation(context)
                if (loc == null) throw Exception("Enable GPS to start a session")
                val s = api.startSession(selectedClass, loc.latitude, loc.longitude, 15)
                sessionId = s.optString("id")
                roster = api.roster(s.optString("id"))
                qrText = api.issueQr(s.optString("id"))
            } catch (e: Exception) {
                error = e.message
            }
            starting = false
        }
    }

    LaunchedEffect(sessionId) {
        val id = sessionId ?: return@LaunchedEffect
        while (true) {
            try { qrText = api.issueQr(id) } catch (_: Exception) {}
            roster = api.roster(id)
            delay(15_000)
        }
    }

    Column(modifier = modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
        Text("Live session", style = MaterialTheme.typography.headlineSmall)
        Text("Start a geofenced session and display the rotating QR for your class.", style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(14.dp))

        error?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(8.dp))
        }

        if (sessionId == null) {
            if (loadingClasses) {
                CircularProgressIndicator(Modifier.padding(20.dp))
            } else if (classes.length() == 0) {
                Text("No classes assigned yet.", style = MaterialTheme.typography.bodyMedium)
            } else {
                ExposedDropdownMenuBox(expanded = classExpanded, onExpandedChange = { classExpanded = it }) {
                    val selectedName = (0 until classes.length())
                        .firstOrNull { classes.getJSONObject(it).optString("id") == selectedClass }
                        ?.let { classes.getJSONObject(it).optString("name") } ?: "Select class"
                    OutlinedTextField(
                        value = selectedName,
                        onValueChange = {},
                        readOnly = true,
                        label = { Text("Class") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = classExpanded) },
                        modifier = Modifier.fillMaxWidth().menuAnchor().padding(bottom = 12.dp),
                    )
                    ExposedDropdownMenu(expanded = classExpanded, onDismissRequest = { classExpanded = false }) {
                        for (i in 0 until classes.length()) {
                            val c = classes.getJSONObject(i)
                            DropdownMenuItem(text = { Text(c.optString("name")) }, onClick = { selectedClass = c.optString("id"); classExpanded = false })
                        }
                    }
                }
                Button(onClick = { start() }, enabled = !starting && selectedClass.isNotEmpty(), modifier = Modifier.fillMaxWidth().height(48.dp)) {
                    if (starting) CircularProgressIndicator(Modifier.width(20.dp).height(20.dp), strokeWidth = 2.dp)
                    else Text("Start session")
                }
            }
        } else {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Session live", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.titleMedium)
                    qrText?.let {
                        Image(bitmap = qrBitmap(it), contentDescription = "Session QR", modifier = Modifier.width(260.dp).height(260.dp))
                    }
                    Text("QR rotates every 15 seconds", style = MaterialTheme.typography.labelSmall)
                }
            }
            Spacer(Modifier.height(14.dp))
            Text("Marked so far (${roster.length()})", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(6.dp))
            if (roster.length() == 0) {
                Text("No students marked yet.", style = MaterialTheme.typography.bodySmall)
            }
            for (i in 0 until roster.length()) {
                val r = roster.getJSONObject(i)
                Card(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
                    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(r.optString("student_name").ifBlank { r.optString("student_id") }, Modifier.weight(1f))
                        Text(r.optString("status"), color = MaterialTheme.colorScheme.primary)
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            TextButton(onClick = { sessionId = null; qrText = null; roster = JSONArray() }) { Text("End session") }
        }
    }
}