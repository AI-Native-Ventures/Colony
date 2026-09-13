# Dictation smoke fixture

`dictation.f32` contains the first ten seconds of the public Moonshine
`test-assets/two_cities.wav` example: a reading of the opening of Charles
Dickens's *A Tale of Two Cities* (public-domain text). Source:
https://github.com/moonshine-ai/moonshine/blob/main/test-assets/two_cities.wav

Converted from mono 48 kHz to 16 kHz by taking every third sample, then written
as little-endian float32 PCM. Used solely for a bounded native decoder smoke
test; this does not establish accent, noise or real microphone accuracy.
