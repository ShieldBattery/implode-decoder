# implode-decoder
A pure JavaScript decoder for the PKWare implode compression algorithm.

Note that this is **not** the same implode algorithm as used in PKZip (compression method 6), but
rather a standalone one that was often used in 90s-era games (e.g. StarCraft, Diablo). I believe
these algorithms are similar, but at the very least the header formats differ.

Implementation is inspired by [StormLib's explode.c](https://github.com/ladislav-zezula/StormLib/blob/master/src%2Fpklib%2Fexplode.c).

## LICENSE
MIT
