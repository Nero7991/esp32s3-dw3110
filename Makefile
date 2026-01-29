.PHONY: initiator responder flash-initiator flash-responder monitor clean

initiator:
	idf.py -DTWR_MODE=initiator build

responder:
	idf.py -DTWR_MODE=responder build

flash-initiator:
	idf.py -DTWR_MODE=initiator flash

flash-responder:
	idf.py -DTWR_MODE=responder flash

monitor:
	idf.py monitor

clean:
	idf.py fullclean
