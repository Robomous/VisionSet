# usage: from visionset.formats.mot import MotExporter, MotImporter
"""MOTChallenge (MOT16/17/20): image sequences and their tracked boxes, imported and exported.

MOTS is not supported: its per-frame instance masks need raster masks, which the domain
does not have yet.
"""

from visionset.formats.mot.reader import MotImporter as MotImporter
from visionset.formats.mot.writer import MotExporter as MotExporter
