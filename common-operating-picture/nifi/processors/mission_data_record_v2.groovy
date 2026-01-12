import groovy.json.JsonBuilder
import groovy.json.JsonSlurper
import org.apache.commons.io.IOUtils
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets
import java.math.BigDecimal

flowFile = session.get()
if(!flowFile) return

latPrecisionPlaces = 7
lngPrecisionPlaces = 8

def coordElementToFloat(coordStr, isLongitude, precisionPlaces) {
    def positiveChar = isLongitude ? "E" : "N"
    def isPositive = coordStr[coordStr.length()-1] == positiveChar
    def valueStr =coordStr.substring(0, coordStr.length()-1)
    def valueDecimal = valueStr.length() - precisionPlaces
    def valueWithDecimal = valueStr.substring(0, valueDecimal) + "." + valueStr.substring(valueDecimal)
    def decimalValue = new BigDecimal(valueWithDecimal)
    if (!isPositive){
        decimalValue = decimalValue.negate()
    }
    return decimalValue
}

def parseLngLat(coordStr){
    def splitIndex = coordStr.indexOf('N') > 0 ? coordStr.indexOf('N') : coordStr.indexOf('S')
    def latStr = coordStr.substring(0, splitIndex+1)
    def lngStr = coordStr.substring(splitIndex+1)
    return [coordElementToFloat(lngStr, true, lngPrecisionPlaces), coordElementToFloat(latStr, false, latPrecisionPlaces)]
}

try {
    def recordList = []
    session.read(flowFile, {inputStream ->
        recordList = new JsonSlurper().parse(inputStream)
    } as InputStreamCallback)

    for (record in recordList){
        def originalData = record['original']
        def enrichedData = record['enrichment']
        def objectType = originalData['Type']
        def tdfAttributes = enrichedData['tdf_attributes']
        def details = originalData['Details']
        
        // Extract Search and Metadata blocks
        def searchData = originalData['Search']
        def metadataData = originalData['Metadata']

        newFlowFile = session.create(flowFile)
        newFlowFile = session.putAttribute(newFlowFile, 'tdf_attribute', tdfAttributes)
        newFlowFile = session.putAttribute(newFlowFile, 'tdf_src', objectType)
        newFlowFile = session.putAttribute(newFlowFile, 'tdf_ts', details['ProducerDateTimeLastChg'])
        
        // Add Search and Metadata as attributes (convert to JSON string)
        if (searchData) {
            newFlowFile = session.putAttribute(newFlowFile, 'tdf_search', new JsonBuilder(searchData).toString())
        }
        if (metadataData) {
            newFlowFile = session.putAttribute(newFlowFile, 'tdf_metadata', new JsonBuilder(metadataData).toString())
        }

        def coordStr = details['Coord']
        lngLat = parseLngLat(coordStr)
        pointMap = ['type' : 'Point', 'coordinates':[lngLat[0], lngLat[1]]]
        def pointJsonString = new JsonBuilder(pointMap).toPrettyString()

        newFlowFile = session.putAttribute(newFlowFile, 'tdf_geo', pointJsonString)
        
        // The payload to be encrypted is just the Details block
        payloadObj = originalData['Details']
        newFlowFile = session.write(newFlowFile, {inputStream, outputStream ->
            def oos = new OutputStreamWriter(outputStream)
            new JsonBuilder(payloadObj).writeTo(oos)
            oos.close()
        } as StreamCallback)

        session.transfer(newFlowFile, REL_SUCCESS)
    }
    session.remove(flowFile)
} catch(Exception ex) {
    log.error('Error processing enriched mission data: {}', ex)
    session.transfer(flowFile, REL_FAILURE)
}