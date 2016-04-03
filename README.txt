This is an experiment into making a Scrapbook X derivative backed by a File/Folder data layer instead of RDF.

Original Scrapbook X saves note structure in a scrapbook.rdf file. Additional data is stored in a personal subfolder of a flat \Data folder.

This structure makes it hard to work with the notes outside of Scrapbook X itself, and it's not suited for synchronization. If you add a note from two different PCs at once, both will produce new versions of scrapbook.rdf, and if you synchronize data with Dropbox or BTSync, only the latest note will remain (even though they are not conflicting!)

This project will try to fix these shortcomings by switching Scrapbook to a File/Folder data layer:

  Scrapbook folder == folder on disk
  Scrapbook note == text file on disk
  Scrapbook bookmark == shortcut on disk
  Scrapbook saved page == mht file on disk (or perhaps a folder)

Folder structure on disk will reflect folder structure in Scrapbook. Desktop.ini or perhaps another file will be used to store additional properties where needed.

This way:
* the data will lend itself better for synchronization (conflics will occur only when there's indeed aconflict)
* Scrapbook data will be better accessible outside Scrapbook (you can just edit it manually)
* Scrapbook will better integrate with existing OS principles

This repo will try to stick as close as possible to the original Scrapbook X in other areas, as the scope of this project does not include anything else other than switching the data layer.

See original Scrapbook X for version details and for other documentation and readme.

Scrapbook X:
https://github.com/danny0838/firefox-scrapbook