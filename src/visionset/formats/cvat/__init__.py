# usage: from visionset.formats.cvat import CvatImagesExporter, CvatVideoImporter
"""CVAT XML 1.1, as two dialects that are named, read and written apart.

``cvat-images`` is "CVAT for images 1.1", shapes per picture; ``cvat-video`` is
"CVAT for video 1.1", tracks of per-frame shapes over one task's frames. Neither
reads the other's documents. See :mod:`.images` and :mod:`.video`.
"""

from visionset.formats.cvat.images import CvatImagesExporter as CvatImagesExporter
from visionset.formats.cvat.images import CvatImagesImporter as CvatImagesImporter
from visionset.formats.cvat.video import CvatVideoExporter as CvatVideoExporter
from visionset.formats.cvat.video import CvatVideoImporter as CvatVideoImporter
