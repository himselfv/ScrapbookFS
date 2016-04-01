@echo off
set PATH=C:\Program Files\WinRAR;%PATH%

del scrapbookx.xpi
rem so that it's not archived

rar a -r -x@compile.exclude.txt scrapbookx.zip *
rar a -r -n@compile.include.txt scrapbookx.zip *
ren scrapbookx.zip scrapbookx.xpi