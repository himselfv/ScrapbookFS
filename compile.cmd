@echo off
set PATH=C:\Program Files\WinRAR;%PATH%

del scrapbookx.xpi
rem so that it's not archived

winrar a -afzip -r -x@compile.exclude.txt scrapbookx.zip *
winrar a -afzip -r -n@compile.include.txt scrapbookx.zip *
ren scrapbookx.zip scrapbookx.xpi